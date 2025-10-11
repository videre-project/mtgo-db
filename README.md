# MTGO-DB

A PostgreSQL database with PgBouncer connection pooling and Cloudflare Tunnel access for Magic: The Gathering Online (MTGO) data.

## What is MTGO-DB?

**MTGO-DB** is a containerized PostgreSQL database infrastructure designed to store and serve MTGO game data for analysis and tracking applications. It provides:

- **PostgreSQL 18** - Primary database server with optimized performance settings
- **PgBouncer** - Connection pooling for efficient database connections  
- **Cloudflare Tunnel** - Secure remote access without exposing ports publicly
- **Docker Compose** - Complete containerized setup for cross-platform deployment

The database schema includes tables for tracking events, matches, decks, players, standings, and archetypes, serving as the data layer for MTGO tracking and analysis tools.

## Installation

> [!NOTE]
> MTGO-DB requires only Docker and Node.js (with pnpm). It runs on any platform that supports Docker containers.

### Requirements

- [Docker](https://docs.docker.com/get-docker/) (with Docker Compose)
- [Node.js](https://nodejs.org/) (v22.6.0 or newer)
- [pnpm](https://pnpm.io/) (v3 or newer)

To install pnpm:

```bash
npm install -g pnpm
```

### Setup

1. **Clone the repository:**

   ```bash
   git clone https://github.com/videre-project/mtgo-db.git
   cd mtgo-db
   ```

2. **Install dependencies:**

   ```bash
   pnpm install
   ```

3. **Configure environment variables:**

   Copy `.env-example` to `.env` and fill in your credentials:

   ```bash
   POSTGRES_USER=your_username
   POSTGRES_PASSWORD=your_secure_password
   POSTGRES_DB=mtgo-db1
   POSTGRES_PORT=6432
   ```

4. **Prepare database dump (optional):**

   If you have an existing database dump, place it in the `postgres/dump/` directory. The dump will be automatically imported on first startup. Supported formats include `.sql` files from `pg_dump`.

5. **Set up Cloudflare Tunnel (optional):**

   Run the interactive setup script to configure remote access:

   ```bash
   pnpm setup-tunnel
   ```

   This will:
   - Authenticate with Cloudflare
   - Create a new tunnel
   - Configure DNS routing
   - Generate tunnel credentials

6. **Start the database:**

   ```bash
   pnpm start
   ```

   This will start all services:
   - PostgreSQL on `localhost:5433`
   - PgBouncer on `localhost:6432`
   - Cloudflare Tunnel (if configured)
   
   > [!NOTE]
   > On first startup, any `.sql` dump files in `postgres/dump/` will be automatically imported. This may take several minutes depending on the size of your data.

## Usage

### Starting the Database

To start all services in the background:

```bash
pnpm start
```

### Stopping the Database

To stop all services:

```bash
pnpm stop
```

### Viewing Logs

To view real-time logs from all containers:

```bash
pnpm logs
```

### Listing Tables

To verify the database connection and view the schema:

```bash
pnpm list-tables
```

This script connects through the Cloudflare tunnel and lists all tables with their columns.

### Importing Data from a Dump

The database automatically imports dump files on first initialization. For manual imports or to update an existing database:

#### Automatic Import (Recommended)

1. Place your `.sql` dump file in the `postgres/dump/` directory
2. Remove the existing database: `docker compose down -v`
3. Start fresh: `pnpm start`

The dump will be automatically imported during initialization. This works for:

- Plain SQL dumps (`pg_dump --format=plain`)
- Dumps with `--clean --if-exists` flags (which safely recreates tables)

#### Manual Import Options

If you need to import into a running database:

##### Using the Import Script

```bash
pnpm run import-dump postgres/dump/mtgo_dump.sql
```

This script:

- Uses Docker exec with `psql` for proper COPY statement handling
- Filters out harmless owner/role errors automatically
- Verifies the import and shows table counts

##### Via Docker Exec

Manually pipe the dump file:

```bash
# For .sql files
docker exec -i postgres-prod psql -U your_username -d mtgo-db1 < postgres/dump/mtgo_dump.sql

# Or pipe directly
cat postgres/dump/mtgo_dump.sql | docker exec -i postgres-prod psql -U $POSTGRES_USER -d $POSTGRES_DB
```

##### Via psql from Host

If you have PostgreSQL client tools installed locally:

```bash
psql -h localhost -p 5433 -U your_username -d mtgo-db1 -f postgres/dump/mtgo_dump.sql
```

##### Via PgBouncer

For remote imports through the connection pooler:

```bash
psql -h localhost -p 6432 -U your_username -d mtgo-db1 -f postgres/dump/mtgo_dump.sql
```

> [!NOTE]
> Automatic import only runs during first-time initialization. If your dump includes `--clean --if-exists` flags (from `pg_dump`), it will safely drop and recreate tables. To reimport, use `docker compose down -v` to reset the database before running `pnpm start`.

### Connecting to the Database

#### Local Connection (via PgBouncer)

```bash
psql -h localhost -p 6432 -U your_username -d mtgo-db1
```

#### Direct Connection to PostgreSQL

```bash
psql -h localhost -p 5433 -U your_username -d mtgo-db1
```

#### Remote Connection (via Cloudflare Tunnel)

Use your configured tunnel hostname with port 6432. Authentication is handled through Cloudflare Access.

## Database Schema

The database includes the following tables:

- **`events`** - Tournament and event information
- **`matches`** - Individual match results and game data
- **`decks`** - Deck lists with mainboard and sideboard
- **`players`** - Player registry
- **`standings`** - Tournament standings and rankings
- **`archetypes`** - Deck archetype classifications

## Configuration

### Environment Variables

All configuration is managed through environment variables in the `.env` file:

- `POSTGRES_USER` - Database username
- `POSTGRES_PASSWORD` - Database password
- `POSTGRES_DB` - Database name
- `POSTGRES_PORT` - PgBouncer port (default: 6432)
- `CLOUDFLARED_TUNNEL_HOSTNAME` - Cloudflare tunnel hostname
- `CLOUDFLARED_TUNNEL_NAME` - Cloudflare tunnel name
- `CLOUDFLARED_TUNNEL_ID` - Cloudflare tunnel ID

### Performance Tuning

PostgreSQL performance settings are configured via SQL scripts in `postgres/initdb.d/`. The default configuration includes:

- `shared_buffers`: 128MB
- `work_mem`: 4MB
- `maintenance_work_mem`: 64MB
- `effective_cache_size`: 512MB

To modify these settings, edit or create SQL scripts in `postgres/initdb.d/` that use `ALTER SYSTEM SET` commands.

### PgBouncer Settings

PgBouncer is configured with:

- `POOL_MODE`: session
- `MAX_CLIENT_CONN`: 100
- `DEFAULT_POOL_SIZE`: 20
- `AUTH_TYPE`: scram-sha-256

## Troubleshooting

### Port Conflicts

If you encounter port conflicts, you can change the ports in `docker-compose.yml`:

- PostgreSQL: Change `127.0.0.1:5433:5432` to a different host port
- PgBouncer: Change `POSTGRES_PORT` in `.env`

### Authentication Issues

If you get "wrong password type" errors, ensure:

1. PgBouncer has `AUTH_TYPE: scram-sha-256` configured
2. Your password is set correctly in `.env`
3. The containers have been recreated after configuration changes

### Docker Issues

MTGO-DB uses named Docker volumes for cross-platform compatibility:

- The database uses a named Docker volume (`postgres-data`) instead of bind mounts
- Data persists across container restarts on all platforms
- To reset the database, run: `docker compose down -v`

## License

This project is licensed under the [Apache-2.0 License](LICENSE).

## Disclaimer

This project is not affiliated with Wizards of the Coast, Daybreak Games, or Magic: The Gathering Online. Magic: The Gathering Online (MTGO) is a trademark of Wizards of the Coast and is operated and published by Daybreak Games under license. All product names, trademarks, and registered trademarks are the property of their respective owners.

This database infrastructure is intended as a data storage solution for MTGO-related applications and tools.

> [!WARNING]
> This is not legal advice. Use this software at your own risk and ensure compliance with all applicable terms of service.
