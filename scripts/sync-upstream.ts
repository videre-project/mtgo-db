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

async function getUpstreamEvents(excludeIds: Set<number>): Promise<EventRecord[]> {
  console.log('Fetching events from upstream database...');
  
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
  
  // Get all players involved in the new events from upstream
  const upstreamPlayers = await upstream<{ id: number; name: string }[]>`
    SELECT DISTINCT p.id, p.name
    FROM players p
    WHERE EXISTS (
      SELECT 1 FROM standings s WHERE s.player = p.name AND s.event_id IN ${upstream(eventIds)}
    ) OR EXISTS (
      SELECT 1 FROM matches m WHERE m.player = p.name AND m.event_id IN ${upstream(eventIds)}
    ) OR EXISTS (
      SELECT 1 FROM decks d WHERE d.player = p.name AND d.event_id IN ${upstream(eventIds)}
    );
  `;
  
  if (upstreamPlayers.length === 0) return 0;
  
  // Get existing local players
  const localPlayers = await local<{ id: number; name: string }[]>`
    SELECT id, name FROM players;
  `;
  
  const localPlayerMap = new Map(localPlayers.map(p => [p.id, p.name]));
  const newPlayers = upstreamPlayers.filter(p => !localPlayerMap.has(p.id));
  
  if (newPlayers.length > 0) {
    await local`
      INSERT INTO players ${local(newPlayers, 'id', 'name')}
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;
    `;
  }
  
  console.log(`Synced ${newPlayers.length} new player(s).\n`);
  return newPlayers.length;
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
  
  await local`
    INSERT INTO standings ${local(standings, 'event_id', 'rank', 'player', 'record', 'points', 'omwp', 'gwp', 'owp')}
    ON CONFLICT (event_id, player) DO UPDATE SET
      rank = EXCLUDED.rank,
      record = EXCLUDED.record,
      points = EXCLUDED.points,
      omwp = EXCLUDED.omwp,
      gwp = EXCLUDED.gwp,
      owp = EXCLUDED.owp;
  `;
  
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
  
  await local`
    INSERT INTO matches ${local(matches, 'id', 'event_id', 'round', 'player', 'opponent', 'record', 'result', 'isbye', 'games')}
    ON CONFLICT (event_id, round, player) DO UPDATE SET
      id = EXCLUDED.id,
      opponent = EXCLUDED.opponent,
      record = EXCLUDED.record,
      result = EXCLUDED.result,
      isbye = EXCLUDED.isbye,
      games = EXCLUDED.games;
  `;
  
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
  
  await local`
    INSERT INTO decks ${local(decks, 'id', 'event_id', 'player', 'mainboard', 'sideboard')}
    ON CONFLICT (id) DO UPDATE SET
      event_id = EXCLUDED.event_id,
      player = EXCLUDED.player,
      mainboard = EXCLUDED.mainboard,
      sideboard = EXCLUDED.sideboard;
  `;
  
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
  
  await local`
    INSERT INTO archetypes ${local(archetypes, 'id', 'deck_id', 'name', 'archetype', 'archetype_id')}
    ON CONFLICT (id) DO UPDATE SET
      deck_id = EXCLUDED.deck_id,
      name = EXCLUDED.name,
      archetype = EXCLUDED.archetype,
      archetype_id = EXCLUDED.archetype_id;
  `;
  
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

    // Get new events from upstream
    const newEvents = await getUpstreamEvents(localEventIds);

    if (newEvents.length === 0) {
      console.log('No new events to sync. Local database is up to date!');
      return;
    }

    // Show preview of events to sync
    console.log('Events to sync:');
    newEvents.slice(0, 5).forEach((event, index) => {
      console.log(`  ${index + 1}. [${event.id}] ${event.name} (${event.date})`);
    });
    if (newEvents.length > 5) {
      console.log(`  ... and ${newEvents.length - 5} more event(s)`);
    }
    console.log('');

    const eventIds = newEvents.map(e => e.id);

    // Sync in order of dependencies
    // 1. Players (no dependencies)
    stats.players = await syncPlayers(eventIds);

    // 2. Events (no dependencies)
    stats.events = await syncEvents(newEvents);

    // 3. Standings (depends on Events and Players)
    stats.standings = await syncStandings(eventIds);

    // 4. Matches (depends on Events and Players)
    stats.matches = await syncMatches(eventIds);

    // 5. Decks (depends on Events and Players)
    stats.decks = await syncDecks(eventIds);

    // 6. Archetypes (depends on Decks)
    stats.archetypes = await syncArchetypes(eventIds);

    // Print summary
    console.log('='.repeat(60));
    console.log('Sync Summary');
    console.log('='.repeat(60));
    console.log(`Events:     ${stats.events}`);
    console.log(`Players:    ${stats.players}`);
    console.log(`Standings:  ${stats.standings}`);
    console.log(`Matches:    ${stats.matches}`);
    console.log(`Decks:      ${stats.decks}`);
    console.log(`Archetypes: ${stats.archetypes}`);
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
