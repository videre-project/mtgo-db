import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

interface SyncStats {
  events: number;
  players: number;
  matches: number;
  decks: number;
  standings: number;
  archetypes: number;
}

interface EventRecord {
  id: number;
  name: string;
  date: Date;
  format: string;
  kind: string;
  rounds: number | null;
  players: number | null;
}

/**
 * Syncs data from an upstream PostgreSQL database to the local database.
 * Only imports events that don't already exist locally.
 * 
 * Usage:
 *   UPSTREAM_CONNECTION_STRING=<connection-string> pnpm run sync-upstream
 * 
 * Example:
 *   UPSTREAM_CONNECTION_STRING="postgres://user:password@host:5432/database" pnpm run sync-upstream
 */

const upstreamConnectionString = process.env.UPSTREAM_CONNECTION_STRING;

if (!upstreamConnectionString) {
  console.error('Error: UPSTREAM_CONNECTION_STRING environment variable is required.');
  console.error('');
  console.error('Usage:');
  console.error('  UPSTREAM_CONNECTION_STRING=<connection-string> pnpm run sync-upstream');
  console.error('');
  console.error('Example:');
  console.error('  UPSTREAM_CONNECTION_STRING="postgres://user:password@host:5432/database" pnpm run sync-upstream');
  process.exit(1);
}

// Parse the connection string to handle URL-encoded database names
let upstreamConfig: any;
try {
  const url = new URL(upstreamConnectionString.replace(/^postgres:/, 'postgresql:'));
  upstreamConfig = {
    host: url.hostname,
    port: parseInt(url.port) || 5432,
    database: decodeURIComponent(url.pathname.slice(1)),
    user: url.username,
    password: url.password,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 30,
  };
  
  // Add SSL and other query parameters
  const params = new URLSearchParams(url.search);
  if (params.has('sslmode') && params.get('sslmode') !== 'disable') {
    upstreamConfig.ssl = params.get('sslmode') === 'require' ? 'require' : true;
  }
} catch (e) {
  // If parsing fails, use the connection string directly
  console.warn('Warning: Could not parse connection string URL, using as-is');
  upstreamConfig = upstreamConnectionString;
}

// Connect to upstream database
const upstream = postgres(upstreamConfig);

// Connect to local database via PgBouncer
const local = postgres({
  host: '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT) || 6432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

async function getLocalEventIds(): Promise<Set<number>> {
  console.log('Fetching existing event IDs from local database...');
  const events = await local<{ id: number }[]>`
    SELECT id FROM events;
  `;
  
  const eventIds = new Set(events.map(e => e.id));
  console.log(`Found ${eventIds.size} existing events locally.\n`);
  return eventIds;
}

async function getIncompleteEventIds(): Promise<number[]> {
  console.log('Checking for incomplete events...');
  
  // Find events that exist locally but are missing essential data
  // An event is considered incomplete if it has players but is missing standings OR matches
  // (We don't check for decks because not all event types have decks, e.g., Preliminaries)
  const incompleteEvents = await local<{ id: number; name: string; date: Date }[]>`
    SELECT DISTINCT e.id, e.name, e.date
    FROM events e
    WHERE 
      e.players > 0 AND (
        -- Missing standings (essential for all events with players)
        NOT EXISTS (SELECT 1 FROM standings s WHERE s.event_id = e.id)
        -- Missing matches (essential for all events with players)
        OR NOT EXISTS (SELECT 1 FROM matches m WHERE m.event_id = e.id)
      )
    ORDER BY e.date DESC, e.id DESC
    LIMIT 100;
  `;
  
  const eventIds = incompleteEvents.map(e => e.id);
  
  if (eventIds.length > 0) {
    console.log(`Found ${eventIds.length} incomplete event(s) to update:`);
    incompleteEvents.slice(0, 5).forEach((event, index) => {
      console.log(`  ${index + 1}. [${event.id}] ${event.name}`);
    });
    if (incompleteEvents.length > 5) {
      console.log(`  ... and ${incompleteEvents.length - 5} more event(s)`);
    }
    console.log('');
  } else {
    console.log('All existing events are complete.\n');
  }
  
  return eventIds;
}

async function getUpstreamEvents(excludeIds: Set<number>): Promise<EventRecord[]> {
  console.log('Fetching new events from upstream database...');
  
  let events;
  if (excludeIds.size === 0) {
    // If no local events, fetch all
    events = await upstream<EventRecord[]>`
      SELECT id, name, date, format, kind, rounds, players
      FROM events
      ORDER BY date DESC, id DESC;
    `;
  } else {
    // Fetch only events not in local database
    const excludeArray = Array.from(excludeIds);
    events = await upstream<EventRecord[]>`
      SELECT id, name, date, format, kind, rounds, players
      FROM events
      WHERE id NOT IN ${upstream(excludeArray)}
      ORDER BY date DESC, id DESC;
    `;
  }
  
  console.log(`Found ${events.length} new event(s) to sync.\n`);
  return events;
}

async function syncPlayers(eventIds: number[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  
  console.log('Syncing players...');
  
  // Get all player names referenced in standings/matches/decks for these events
  const referencedPlayerNames = await upstream<{ player: string }[]>`
    SELECT DISTINCT player FROM standings WHERE event_id IN ${upstream(eventIds)}
    UNION
    SELECT DISTINCT player FROM matches WHERE event_id IN ${upstream(eventIds)}
    UNION
    SELECT DISTINCT player FROM decks WHERE event_id IN ${upstream(eventIds)}
  `;
  
  if (referencedPlayerNames.length === 0) return 0;
  
  const playerNames = referencedPlayerNames.map(r => r.player);
  
  // Get player records from upstream (may not exist for all players)
  const upstreamPlayers = await upstream<{ id: number | null; name: string }[]>`
    SELECT p.id, p.name
    FROM players p
    WHERE p.name IN ${upstream(playerNames)}
  `;
  
  // Create a map of existing upstream players
  const upstreamPlayerMap = new Map(upstreamPlayers.map(p => [p.name, p.id]));
  
  // Get existing local players
  const localPlayers = await local<{ id: number; name: string }[]>`
    SELECT id, name FROM players;
  `;
  
  const localPlayerNameMap = new Map(localPlayers.map(p => [p.name, p.id]));
  const localPlayerIdSet = new Set(localPlayers.map(p => p.id));

  // Prepare players to sync - use upstream ID, otherwise mark w/ negative IDs
  // This makes them easy to query later: SELECT * FROM players WHERE id < 0
  const negativeIds = localPlayers.filter(p => p.id < 0).map(p => p.id);
  const minNegativeId = negativeIds.length > 0 ? Math.min(...negativeIds) : 0;
  let nextNegativeId = minNegativeId - 1;
  
  const playersToSync: { id: number; name: string }[] = [];
  
  for (const playerName of playerNames) {
    if (localPlayerNameMap.has(playerName)) {
      // Already exists locally, skip
      continue;
    }
    
    // Use upstream ID if available, otherwise assign negative ID
    let id = upstreamPlayerMap.get(playerName) ?? nextNegativeId--;
    
    // If the upstream ID already exists locally (different player), use a negative ID instead
    if (id !== undefined && id !== null && id > 0 && localPlayerIdSet.has(id)) {
      console.warn(`  Warning: Player ID ${id} already exists locally for a different player. Player "${playerName}" will be assigned temporary ID ${nextNegativeId}`);
      id = nextNegativeId--;
    }
    
    playersToSync.push({ id, name: playerName });

    if (id < 0) {
      console.warn(`  Warning: Player "${playerName}" does not exist upstream, assigned temporary ID ${id}`);
    }
  }
  
  if (playersToSync.length > 0) {
    await local`
      INSERT INTO players ${local(playersToSync, 'id', 'name')}
      ON CONFLICT (name) DO NOTHING;
    `;
  }
  
  console.log(`Synced ${playersToSync.length} new player(s).\n`);
  return playersToSync.length;
}

async function syncEvents(events: EventRecord[]): Promise<number> {
  if (events.length === 0) return 0;
  
  console.log('Syncing events...');
  
  await local`
    INSERT INTO events ${local(events, 'id', 'name', 'date', 'format', 'kind', 'rounds', 'players')}
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      date = EXCLUDED.date,
      format = EXCLUDED.format,
      kind = EXCLUDED.kind,
      rounds = EXCLUDED.rounds,
      players = EXCLUDED.players;
  `;
  
  console.log(`Synced ${events.length} event(s).\n`);
  return events.length;
}

async function syncStandings(eventIds: number[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  
  console.log('Syncing standings...');
  
  const standings = await upstream`
    SELECT event_id, rank, player, record, points, omwp, gwp, owp
    FROM standings
    WHERE event_id IN ${upstream(eventIds)}
    ORDER BY event_id, rank;
  `;
  
  if (standings.length === 0) return 0;
  
  // Insert in batches to avoid parameter limit
  // Each standing has 8 fields, so we can safely insert ~8000 standings per batch
  const BATCH_SIZE = 8000;
  let totalSynced = 0;
  
  for (let i = 0; i < standings.length; i += BATCH_SIZE) {
    const batch = standings.slice(i, i + BATCH_SIZE);
    await local`
      INSERT INTO standings ${local(batch, 'event_id', 'rank', 'player', 'record', 'points', 'omwp', 'gwp', 'owp')}
      ON CONFLICT (event_id, player) DO UPDATE SET
        rank = EXCLUDED.rank,
        record = EXCLUDED.record,
        points = EXCLUDED.points,
        omwp = EXCLUDED.omwp,
        gwp = EXCLUDED.gwp,
        owp = EXCLUDED.owp;
    `;
    totalSynced += batch.length;
    if (standings.length > BATCH_SIZE) {
      console.log(`  Synced ${totalSynced}/${standings.length} standings...`);
    }
  }
  
  console.log(`Synced ${standings.length} standing(s).\n`);
  return standings.length;
}

async function syncMatches(eventIds: number[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  
  console.log('Syncing matches...');
  
  const matches = await upstream`
    SELECT id, event_id, round, player, opponent, record, result, isbye, games
    FROM matches
    WHERE event_id IN ${upstream(eventIds)}
    ORDER BY event_id, round, player;
  `;
  
  if (matches.length === 0) return 0;
  
  // Insert in batches to avoid parameter limit (65,534 parameters)
  // Each match has 9 fields, so we can safely insert ~7000 matches per batch
  const BATCH_SIZE = 7000;
  let totalSynced = 0;
  
  for (let i = 0; i < matches.length; i += BATCH_SIZE) {
    const batch = matches.slice(i, i + BATCH_SIZE);
    await local`
      INSERT INTO matches ${local(batch, 'id', 'event_id', 'round', 'player', 'opponent', 'record', 'result', 'isbye', 'games')}
      ON CONFLICT (event_id, round, player) DO UPDATE SET
        id = EXCLUDED.id,
        opponent = EXCLUDED.opponent,
        record = EXCLUDED.record,
        result = EXCLUDED.result,
        isbye = EXCLUDED.isbye,
        games = EXCLUDED.games;
    `;
    totalSynced += batch.length;
    if (matches.length > BATCH_SIZE) {
      console.log(`  Synced ${totalSynced}/${matches.length} matches...`);
    }
  }
  
  console.log(`Synced ${matches.length} match(es).\n`);
  return matches.length;
}

async function syncDecks(eventIds: number[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  
  console.log('Syncing decks...');
  
  const decks = await upstream`
    SELECT id, event_id, player, mainboard, sideboard
    FROM decks
    WHERE event_id IN ${upstream(eventIds)}
    ORDER BY event_id, player;
  `;
  
  if (decks.length === 0) return 0;
  
  // Insert in batches to avoid parameter limit
  // Each deck has 5 fields, so we can safely insert ~13000 decks per batch
  const BATCH_SIZE = 13000;
  let totalSynced = 0;
  
  for (let i = 0; i < decks.length; i += BATCH_SIZE) {
    const batch = decks.slice(i, i + BATCH_SIZE);
    await local`
      INSERT INTO decks ${local(batch, 'id', 'event_id', 'player', 'mainboard', 'sideboard')}
      ON CONFLICT (id) DO UPDATE SET
        event_id = EXCLUDED.event_id,
        player = EXCLUDED.player,
        mainboard = EXCLUDED.mainboard,
        sideboard = EXCLUDED.sideboard;
    `;
    totalSynced += batch.length;
    if (decks.length > BATCH_SIZE) {
      console.log(`  Synced ${totalSynced}/${decks.length} decks...`);
    }
  }
  
  console.log(`Synced ${decks.length} deck(s).\n`);
  return decks.length;
}

async function syncArchetypes(eventIds: number[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  
  console.log('Syncing archetypes...');
  
  // Get deck IDs from the synced events
  const deckIds = await upstream<{ id: number }[]>`
    SELECT id FROM decks WHERE event_id IN ${upstream(eventIds)};
  `;
  
  if (deckIds.length === 0) return 0;
  
  const deckIdArray = deckIds.map(d => d.id);
  
  const archetypes = await upstream`
    SELECT id, deck_id, name, archetype, archetype_id
    FROM archetypes
    WHERE deck_id IN ${upstream(deckIdArray)}
    ORDER BY id;
  `;
  
  if (archetypes.length === 0) return 0;
  
  // Insert in batches to avoid parameter limit
  // Each archetype has 5 fields, so we can safely insert ~13000 archetypes per batch
  const BATCH_SIZE = 13000;
  let totalSynced = 0;
  
  for (let i = 0; i < archetypes.length; i += BATCH_SIZE) {
    const batch = archetypes.slice(i, i + BATCH_SIZE);
    await local`
      INSERT INTO archetypes ${local(batch, 'id', 'deck_id', 'name', 'archetype', 'archetype_id')}
      ON CONFLICT (id) DO UPDATE SET
        deck_id = EXCLUDED.deck_id,
        name = EXCLUDED.name,
        archetype = EXCLUDED.archetype,
        archetype_id = EXCLUDED.archetype_id;
    `;
    totalSynced += batch.length;
    if (archetypes.length > BATCH_SIZE) {
      console.log(`  Synced ${totalSynced}/${archetypes.length} archetypes...`);
    }
  }
  
  console.log(`Synced ${archetypes.length} archetype(s).\n`);
  return archetypes.length;
}

async function sync(): Promise<void> {
  const stats: SyncStats = {
    events: 0,
    players: 0,
    matches: 0,
    decks: 0,
    standings: 0,
    archetypes: 0,
  };

  try {
    console.log('='.repeat(60));
    console.log('MTGO Database Sync - Upstream to Local');
    console.log('='.repeat(60));
    console.log('');

    // Check connection to upstream
    console.log('Testing upstream database connection...');
    try {
      await upstream`SELECT 1`;
      console.log('✓ Connected to upstream database.\n');
    } catch (err) {
      throw new Error(`Failed to connect to upstream database: ${err}`);
    }

    // Check connection to local
    console.log('Testing local database connection...');
    try {
      await local`SELECT 1`;
      console.log('✓ Connected to local database.\n');
    } catch (err) {
      throw new Error(`Failed to connect to local database: ${err}`);
    }

    // Get local event IDs to exclude
    const localEventIds = await getLocalEventIds();

    // Get incomplete events that need updating
    const incompleteEventIds = await getIncompleteEventIds();

    // Get new events from upstream
    const newEvents = await getUpstreamEvents(localEventIds);

    // Combine new events and incomplete events
    const allEventIdsToSync = [
      ...newEvents.map(e => e.id),
      ...incompleteEventIds
    ];

    // Show preview of new events to sync
    if (newEvents.length > 0) {
      console.log(`New events to sync (${newEvents.length}):`);
      newEvents.slice(0, 5).forEach((event, index) => {
        console.log(`  ${index + 1}. [${event.id}] ${event.name} (${event.date})`);
      });
      if (newEvents.length > 5) {
        console.log(`  ... and ${newEvents.length - 5} more event(s)`);
      }
      console.log('');
    }

    if (allEventIdsToSync.length === 0) {
      console.log('No events to sync. Local database is up to date!');
      
      // Still show summary with zeros
      console.log('');
      console.log('='.repeat(60));
      console.log('Sync Summary');
      console.log('='.repeat(60));
      console.log(`New Events:       0`);
      console.log(`Updated Events:   0`);
      console.log(`Total Events:     0`);
      console.log(`-`.repeat(60));
      console.log(`Players:          0`);
      console.log(`Standings:        0`);
      console.log(`Matches:          0`);
      console.log(`Decks:            0`);
      console.log(`Archetypes:       0`);
      console.log('='.repeat(60));
      return;
    }

    // Sync in order of dependencies
    // 1. Players (no dependencies)
    stats.players = await syncPlayers(allEventIdsToSync);

    // 2. Events (no dependencies) - only sync new events
    if (newEvents.length > 0) {
      stats.events = await syncEvents(newEvents);
    }

    // 3. Standings (depends on Events and Players)
    stats.standings = await syncStandings(allEventIdsToSync);

    // 4. Matches (depends on Events and Players)
    stats.matches = await syncMatches(allEventIdsToSync);

    // 5. Decks (depends on Events and Players)
    stats.decks = await syncDecks(allEventIdsToSync);

    // 6. Archetypes (depends on Decks)
    stats.archetypes = await syncArchetypes(allEventIdsToSync);

    // Print summary
    console.log('='.repeat(60));
    console.log('Sync Summary');
    console.log('='.repeat(60));
    console.log(`New Events:       ${newEvents.length}`);
    console.log(`Updated Events:   ${incompleteEventIds.length}`);
    console.log(`Total Events:     ${allEventIdsToSync.length}`);
    console.log(`-`.repeat(60));
    console.log(`Players:          ${stats.players}`);
    console.log(`Standings:        ${stats.standings}`);
    console.log(`Matches:          ${stats.matches}`);
    console.log(`Decks:            ${stats.decks}`);
    console.log(`Archetypes:       ${stats.archetypes}`);
    console.log('='.repeat(60));
    console.log('');
    console.log('✓ Sync completed successfully!');

  } catch (err) {
    console.error('');
    console.error('Error during sync:', err);
    process.exit(1);
  } finally {
    await upstream.end();
    await local.end();
  }
}

sync();
