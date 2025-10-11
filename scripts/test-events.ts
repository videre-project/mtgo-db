import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

// Connect to local database via PgBouncer
const sql = postgres({
  host: '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT) || 6432,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

async function fetchRecentEvents(): Promise<void> {
  try {
    console.log('Fetching the last 10 events from the database...\n');

    const events = await sql`
      SELECT 
        id,
        name,
        date,
        format,
        kind,
        rounds,
        players
      FROM events
      ORDER BY date DESC, id DESC
      LIMIT 10;
    `;

    if (events.length === 0) {
      console.log('No events found in the database.');
      return;
    }

    console.log(`Found ${events.length} recent event(s):\n`);

    events.forEach((event, index) => {
      console.log(`${index + 1}. ${event.name}`);
      console.log(`   ID: ${event.id}`);
      console.log(`   Date: ${event.date}`);
      console.log(`   Format: ${event.format}`);
      console.log(`   Type: ${event.kind}`);
      console.log(`   Rounds: ${event.rounds || 'N/A'}`);
      console.log(`   Players: ${event.players || 'N/A'}`);
      console.log('');
    });

  } catch (err) {
    console.error('Error fetching events:', err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

fetchRecentEvents();
