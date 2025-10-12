import postgres from 'postgres';
import dotenv from 'dotenv';
import { spawn } from 'child_process';
import { createReadStream } from 'fs';
import { resolve } from 'path';

dotenv.config();

const TEMP_DB = 'mtgo_temp_merge';

// Connect to local database via PgBouncer
const sql = postgres({
  host: '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT) || 6432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

// Connect directly to PostgreSQL for administration
const sqlDirect = postgres({
  host: '127.0.0.1',
  port: 5433,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: 'postgres', // Default database
});

interface MergeStats {
  events: number;
  players: number;
  matches: number;
  decks: number;
  standings: number;
  archetypes: number;
}

async function execDockerPsql(database: string, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', [
      'exec',
      '-i',
      'postgres-prod',
      'psql',
      '-U',
      process.env.POSTGRES_USER!,
      '-d',
      database,
      '-c',
      command,
    ]);

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed: ${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

async function importDumpToTemp(dumpFile: string): Promise<void> {
  const absPath = resolve(dumpFile);
  
  return new Promise((resolve, reject) => {
    // Use pg_restore for custom format dumps (i.e. with --no-owner and --no-acl)
    const proc = spawn('docker', [
      'exec',
      '-i',
      'postgres-prod',
      'pg_restore',
      '--no-owner',
      '--no-acl',
      '-U',
      process.env.POSTGRES_USER!,
      '-d',
      TEMP_DB,
    ]);

    const fileStream = createReadStream(absPath);
    
    let stderr = '';
    let streamEnded = false;
    let procClosed = false;
    
    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      // Filter out expected warnings
      if (!msg.includes('role') && 
          !msg.includes('does not exist') &&
          !msg.includes('already exists') &&
          !msg.includes('extension')) {
        stderr += msg;
      }
    });

    fileStream.on('end', () => {
      streamEnded = true;
      proc.stdin.end();
    });

    fileStream.on('error', (err) => {
      proc.kill();
      reject(err);
    });

    proc.stdin.on('error', (err) => {
      // Ignore EPIPE errors (broken pipe when pg_restore exits before stream finishes)
      if (err.message !== 'write EOF' && !err.message.includes('EPIPE')) {
        console.error('stdin error:', err);
      }
    });

    proc.on('close', (code) => {
      procClosed = true;
      // pg_restore may exit with code 1 even on success due to warnings
      // Only reject if there are actual errors in stderr
      if (code !== 0 && stderr && !stderr.includes('WARNING')) {
        reject(new Error(`Import failed: ${stderr}`));
      } else {
        resolve();
      }
    });

    fileStream.pipe(proc.stdin);
  });
}

async function mergeDatabases(): Promise<MergeStats> {
  const stats: MergeStats = {
    events: 0,
    players: 0,
    matches: 0,
    decks: 0,
    standings: 0,
    archetypes: 0,
  };

  console.log('Analyzing differences between databases...\n');

  // Connect to temp database to query it
  const sqlTemp = postgres({
    host: '127.0.0.1',
    port: 5433,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: TEMP_DB,
  });

  try {
    // 1. Merge Players (upsert)
    console.log('Merging players...');
    const newPlayers = await sqlTemp`
      SELECT id, name FROM players
      WHERE id NOT IN (SELECT id FROM dblink(
        'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
        'SELECT id FROM players'
      ) AS t(id INT))
    `;
    
    for (const player of newPlayers) {
      await sql`INSERT INTO players (id, name) VALUES (${player.id}, ${player.name}) ON CONFLICT (id) DO NOTHING`;
      stats.players++;
    }
    console.log(`  ✓ Added ${stats.players} new players`);

    // 2. Merge Events
    console.log('Merging events...');
    const newEvents = await sqlTemp`
      SELECT id, name, date, format, kind, rounds, players FROM events
      WHERE id NOT IN (SELECT id FROM dblink(
        'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
        'SELECT id FROM events'
      ) AS t(id INT))
    `;

    for (const event of newEvents) {
      await sql`
        INSERT INTO events (id, name, date, format, kind, rounds, players)
        VALUES (${event.id}, ${event.name}, ${event.date}, ${event.format}, ${event.kind}, ${event.rounds}, ${event.players})
        ON CONFLICT (id) DO NOTHING
      `;
      stats.events++;
    }
    console.log(`  ✓ Added ${stats.events} new events`);

    // 3. Merge Decks (only for new events)
    console.log('Merging decks...');
    const newDecks = await sqlTemp`
      SELECT id, event_id, player, mainboard, sideboard FROM decks
      WHERE id NOT IN (SELECT id FROM dblink(
        'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
        'SELECT id FROM decks'
      ) AS t(id INT))
      AND player IN (SELECT name FROM dblink(
        'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
        'SELECT name FROM players'
      ) AS t(name VARCHAR))
    `;

    for (const deck of newDecks) {
      try {
        await sql`
          INSERT INTO decks (id, event_id, player, mainboard, sideboard)
          VALUES (${deck.id}, ${deck.event_id}, ${deck.player}, ${deck.mainboard}, ${deck.sideboard})
          ON CONFLICT (id) DO NOTHING
        `;
        stats.decks++;
      } catch (err) {
        // Skip decks that violate constraints (missing player/event)
        console.log(`    Skipped deck ${deck.id} (constraint violation)`);
      }
    }
    console.log(`  ✓ Added ${stats.decks} new decks`);

    // 4. Merge Matches (composite key: event_id, round, player)
    console.log('Merging matches...');
    const newMatches = await sqlTemp`
      SELECT id, event_id, round, player, opponent, record, result, isbye, games FROM matches
      WHERE (event_id, round, player) NOT IN (
        SELECT event_id, round, player FROM dblink(
          'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
          'SELECT event_id, round, player FROM matches'
        ) AS t(event_id INT, round INT, player VARCHAR)
      )
      AND player IN (SELECT name FROM dblink(
        'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
        'SELECT name FROM players'
      ) AS t(name VARCHAR))
      AND event_id IN (SELECT id FROM dblink(
        'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
        'SELECT id FROM events'
      ) AS t(id INT))
    `;

    for (const match of newMatches) {
      try {
        await sql`
          INSERT INTO matches (id, event_id, round, player, opponent, record, result, isbye, games)
          VALUES (${match.id}, ${match.event_id}, ${match.round}, ${match.player}, ${match.opponent}, ${match.record}, ${match.result}, ${match.isbye}, ${match.games})
          ON CONFLICT (event_id, round, player) DO NOTHING
        `;
        stats.matches++;
      } catch (err) {
        // Skip matches that violate constraints
      }
    }
    console.log(`  ✓ Added ${stats.matches} new matches`);

    // 5. Merge Standings (composite key: event_id, player)
    console.log('Merging standings...');
    const newStandings = await sqlTemp`
      SELECT event_id, rank, player, record, points, omwp, gwp, owp FROM standings
      WHERE (event_id, player) NOT IN (
        SELECT event_id, player FROM dblink(
          'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
          'SELECT event_id, player FROM standings'
        ) AS t(event_id INT, player VARCHAR)
      )
      AND player IN (SELECT name FROM dblink(
        'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
        'SELECT name FROM players'
      ) AS t(name VARCHAR))
      AND event_id IN (SELECT id FROM dblink(
        'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
        'SELECT id FROM events'
      ) AS t(id INT))
    `;

    for (const standing of newStandings) {
      try {
        await sql`
          INSERT INTO standings (event_id, rank, player, record, points, omwp, gwp, owp)
          VALUES (${standing.event_id}, ${standing.rank}, ${standing.player}, ${standing.record}, ${standing.points}, ${standing.omwp}, ${standing.gwp}, ${standing.owp})
          ON CONFLICT (event_id, player) DO NOTHING
        `;
        stats.standings++;
      } catch (err) {
        // Skip standings that violate constraints
      }
    }
    console.log(`  ✓ Added ${stats.standings} new standings`);

    // 6. Merge Archetypes
    console.log('Merging archetypes...');
    const newArchetypes = await sqlTemp`
      SELECT id, deck_id, name, archetype, archetype_id FROM archetypes
      WHERE id NOT IN (
        SELECT id FROM dblink(
          'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
          'SELECT id FROM archetypes'
        ) AS t(id INT)
      )
      AND (deck_id IS NULL OR deck_id IN (SELECT id FROM dblink(
        'host=localhost port=5432 dbname=${sql.unsafe(process.env.POSTGRES_DB!)} user=${sql.unsafe(process.env.POSTGRES_USER!)} password=${sql.unsafe(process.env.POSTGRES_PASSWORD!)}',
        'SELECT id FROM decks'
      ) AS t(id INT)))
    `;

    for (const archetype of newArchetypes) {
      try {
        await sql`
          INSERT INTO archetypes (id, deck_id, name, archetype, archetype_id)
          VALUES (${archetype.id}, ${archetype.deck_id}, ${archetype.name}, ${archetype.archetype}, ${archetype.archetype_id})
          ON CONFLICT (id) DO NOTHING
        `;
        stats.archetypes++;
      } catch (err) {
        // Skip archetypes that violate constraints
      }
    }
    console.log(`  ✓ Added ${stats.archetypes} new archetypes`);

  } finally {
    await sqlTemp.end();
  }

  return stats;
}

async function main(): Promise<void> {
  const dumpFile = process.argv[2];

  if (!dumpFile) {
    console.error('Usage: pnpm merge-dump <dump-file.sql>');
    console.error('\nThis script merges data from an older dump into your current database.');
    console.error('It only imports records that do not already exist (based on primary keys).');
    process.exit(1);
  }

  try {
    console.log('🔄 MTGO Database Merge Utility\n');
    console.log(`Source dump: ${dumpFile}`);
    console.log(`Target database: ${process.env.POSTGRES_DB}\n`);

    // Step 1: Create temporary database
    console.log('Creating temporary database...');
    try {
      await sqlDirect`DROP DATABASE IF EXISTS ${sql.unsafe(TEMP_DB)}`;
      await sqlDirect`CREATE DATABASE ${sql.unsafe(TEMP_DB)}`;
      console.log(`  ✓ Created temporary database: ${TEMP_DB}\n`);
    } catch (err) {
      console.error('Failed to create temp database:', err);
      throw err;
    }

    // Step 2: Enable dblink extension in both databases
    console.log('Enabling dblink extension...');
    await execDockerPsql(TEMP_DB, 'CREATE EXTENSION IF NOT EXISTS dblink;');
    await execDockerPsql(process.env.POSTGRES_DB!, 'CREATE EXTENSION IF NOT EXISTS dblink;');
    console.log('  ✓ dblink enabled\n');

    // Step 3: Import dump into temporary database
    console.log('Importing dump into temporary database...');
    await importDumpToTemp(dumpFile);
    console.log('  ✓ Dump imported successfully\n');

    // Step 3.5: Verify schema was created
    console.log('Verifying schema...');
    const sqlTempCheck = postgres({
      host: '127.0.0.1',
      port: 5433,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: TEMP_DB,
    });
    
    try {
      const tables = await sqlTempCheck`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;
      console.log('  Tables found:', tables.map(t => t.table_name).join(', '));
      
      if (tables.length === 0) {
        throw new Error('No tables found in temporary database - dump may not have imported correctly');
      }
    } finally {
      await sqlTempCheck.end();
    }
    console.log('');

    // Step 4: Merge data from temp to main database
    const stats = await mergeDatabases();

    // Step 5: Cleanup
    console.log('\nCleaning up...');
    await sqlDirect`DROP DATABASE IF EXISTS ${sql.unsafe(TEMP_DB)}`;
    console.log('  ✓ Temporary database removed\n');

    // Summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Merge completed successfully.\n');
    console.log('Summary of new records added:');
    console.log(`  • Players:    ${stats.players.toLocaleString()}`);
    console.log(`  • Events:     ${stats.events.toLocaleString()}`);
    console.log(`  • Decks:      ${stats.decks.toLocaleString()}`);
    console.log(`  • Matches:    ${stats.matches.toLocaleString()}`);
    console.log(`  • Standings:  ${stats.standings.toLocaleString()}`);
    console.log(`  • Archetypes: ${stats.archetypes.toLocaleString()}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  } catch (err) {
    console.error('\n  Merge failed:', err);
    
    // Attempt cleanup
    try {
      await sqlDirect`DROP DATABASE IF EXISTS ${sql.unsafe(TEMP_DB)}`;
    } catch {
      // Ignore cleanup errors
    }
    
    process.exit(1);
  } finally {
    await sql.end();
    await sqlDirect.end();
  }
}

main();
