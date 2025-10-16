# MTGO-DB

A high-availability PostgreSQL database with read replicas, intelligent load balancing via Pgpool-II, automated backups, and Cloudflare Tunnel access for Magic: The Gathering Online (MTGO) data.

## What is MTGO-DB?

**MTGO-DB** is a containerized PostgreSQL database infrastructure designed to store and serve MTGO game data for analysis and tracking applications. It provides:

- **PostgreSQL 18** - Primary database server with optimized performance settings and streaming replication
- **Read Replicas** - Hot standby replicas for read query load distribution
- **Pgpool-II** - Intelligent connection pooling with automatic read/write query splitting
- **Automated Backups** - Backup service that monitors database activity and creates backups after writes
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
   - PostgreSQL Primary on `localhost:5433`
   - PostgreSQL Read Replica (internal)
   - Pgpool-II on `localhost:6432` (with automatic read/write splitting)
   - Automated Backup Service
   - Cloudflare Tunnel (if configured)

> [!NOTE]
> On first startup, any `latest-backup.sql` file in `postgres/dump/` will be automatically restored. If no backup exists, the database will be initialized fresh. This may take several minutes depending on the size of your data.

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

Or view logs for specific services:

```bash
docker compose logs -f postgres          # Primary database
docker compose logs -f pgpool            # Connection pooler
docker compose logs -f backup            # Backup service
docker compose logs -f postgres-replica  # Read replica
```

### Database Backups

MTGO-DB includes an intelligent automated backup system that monitors database activity and creates backups after write operations.

#### Automatic Backups

The backup service runs continuously and:
- Monitors the database for write activity
- Creates a backup 5 minutes after the last write (configurable)
- Enforces a minimum 1-hour interval between backups (configurable)
- Saves timestamped backups to `postgres/dump/backup-YYYY-MM-DD_HH-MM-SS.sql`
- Maintains a `latest-backup.sql` file for easy restoration
- Automatically cleans up backups older than 30 days

Configure backup timing via environment variables in `docker-compose.yml`:
```yaml
BACKUP_AFTER_WRITE_DELAY: "300" # Wait 5 minutes after last write (seconds)
MIN_BACKUP_INTERVAL: "3600"     # Minimum 1 hour between backups (seconds)
```

#### Manual Backups

To create an immediate manual backup (in addition to automatic backups):

```bash
pnpm run export-dump
```

This creates a dump file at `postgres/dump/mtgo_dump.sql`. You can also specify a custom output path:

```bash
pnpm run export-dump postgres/dump/my-backup.sql
```

#### Restoring from Backup

**Automatic Restore (Recommended)**

Any `.sql` files in the `postgres/dump/` directory are automatically imported when the database is first created. To restore from a backup:

```bash
# Stop and remove all data
docker compose down -v

# Start fresh - automatically imports ALL .sql files from postgres/dump/
# Including latest-backup.sql if it exists
pnpm start
```

The initialization process will:
1. Import all `.sql` files found in `postgres/dump/` (via `1_migrate.sh`)
2. Specifically restore from `latest-backup.sql` if present (via `2_restore.sh`)

**Manual Restore (Running Database)**

To restore into an already-running database without recreating it:

```bash
pnpm run import-dump postgres/dump/mtgo_dump.sql
```

> [!WARNING]
> Manual imports into a running database may cause conflicts if tables already exist. Automatic restore during initialization is preferred in cases where you want to completely reset the database state.

### Listing Tables

To verify the database connection and view the schema:

```bash
pnpm list-tables
```

This script connects through the Cloudflare tunnel and lists all tables with their columns.

### Syncing from Upstream Database

To sync new events from another PostgreSQL database:

```bash
UPSTREAM_CONNECTION_STRING="postgres://user:password@host:5432/database" pnpm run sync-upstream
```

Or add `UPSTREAM_CONNECTION_STRING` to your `.env` file:

```env
# .env
UPSTREAM_CONNECTION_STRING=postgres://user:password@host:5432/database
```

Then run:

```bash
pnpm run sync-upstream
```

The script will:
- Connect to both the upstream and local databases
- Identify events not present locally
- Sync only new events and all related data (players, standings, matches, decks, archetypes)
- Handle table dependencies automatically
- Provide a detailed summary of synced records

Use the below connection string format to specify your upstream database:
```
postgres://[user]:[password]@[host]:[port]/[database]?[options]
```

> [!NOTE]
> Ensure the upstream database is accessible from your environment.
> Note that the script is designed for one-way syncing and does not handle deletions or updates from the upstream source. However, the script is idempotent and safe to run multiple times. It is recommended to use a read-only user for the upstream connection and prefer a pub/sub or replication method over periodic syncing when possible.

### Importing Data from a Dump

The database automatically imports **all `.sql` files** from the `postgres/dump/` directory on first initialization.

#### Automatic Import (Recommended)

1. Place your `.sql` dump file(s) in the `postgres/dump/` directory
2. Remove the existing database: `docker compose down -v`
3. Start fresh: `pnpm start`

**All `.sql` files in `postgres/dump/`** will be automatically imported during initialization. This includes:

- The automated `latest-backup.sql` (created by the backup service)
- Any `backup-YYYY-MM-DD_HH-MM-SS.sql` files (timestamped backups)
- Custom dump files you've added (e.g., `mtgo_dump.sql`)

This works for:

- Plain SQL dumps (`pg_dump --format=plain`)
- Dumps with `--clean --if-exists` flags (which safely recreates tables)

> [!TIP]
> Simply having backup files in `postgres/dump/` means they'll automatically be restored when you recreate the database with `docker compose down -v && pnpm start`.

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
> Automatic import runs during first-time initialization when the database volume is empty. All `.sql` files in `postgres/dump/` will be imported. If your dumps include `--clean --if-exists` flags, they will safely drop and recreate tables. To trigger a fresh import, use `docker compose down -v` to remove the data volume, then run `pnpm start`.

### Connecting to the Database

#### Local Connection (via Pgpool-II - Recommended)

Connect through Pgpool-II for automatic read/write splitting:

```bash
psql -h localhost -p 6432 -U your_username -d mtgo-db1
```

All `SELECT` queries are automatically routed to the read replica, while write operations (`INSERT`, `UPDATE`, `DELETE`) go to the primary database. This is completely transparent to your application.

#### Direct Connection to Primary PostgreSQL

For administrative tasks or when you need to bypass Pgpool-II:

```bash
psql -h localhost -p 5433 -U your_username -d mtgo-db1
```

#### Remote Connection (via Cloudflare Tunnel)

Use your configured tunnel hostname with port 6432. Authentication is handled through Cloudflare Access. The tunnel connects to Pgpool-II, so remote users automatically benefit from read/write splitting.

#### Read-Only Public User

A `public_user` is configured with read-only access. All queries from this user are automatically routed to read replicas:

```bash
psql -h localhost -p 6432 -U public_user -d mtgo-db1
```

> [!NOTE]
> Remember to change the default password for `public_user` in `postgres/public_user.sql` before deploying to production.

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

- `POSTGRES_USER` - Database username (used for admin access)
- `POSTGRES_PASSWORD` - Database password
- `POSTGRES_DB` - Database name
- `POSTGRES_PORT` - Pgpool-II port (default: 6432)
- `CLOUDFLARED_TUNNEL_HOSTNAME` - Cloudflare tunnel hostname
- `CLOUDFLARED_TUNNEL_NAME` - Cloudflare tunnel name
- `CLOUDFLARED_TUNNEL_ID` - Cloudflare tunnel ID
- `BACKUP_AFTER_WRITE_DELAY` - Seconds to wait after last write before backing up (default: 300)
- `MIN_BACKUP_INTERVAL` - Minimum seconds between backups (default: 3600)

### Performance Tuning

PostgreSQL performance settings are configured in `docker-compose.yml` via environment variables. The default configuration includes:

- `shared_buffers`: 128MB
- `work_mem`: 4MB
- `maintenance_work_mem`: 64MB
- `effective_cache_size`: 512MB
- `wal_level`: replica (enables streaming replication)
- `max_wal_senders`: 10 (supports up to 10 replicas)
- `max_replication_slots`: 10

To modify these settings, edit the environment variables in `docker-compose.yml` under the `postgres` service.

### Pgpool-II Settings

Pgpool-II is configured with:

- **Load Balancing**: Enabled - `SELECT` queries distributed to replicas
- **Master/Slave Mode**: Stream replication mode
- **Backend Weights**: Primary weight 0, Replica weight 1 (all reads go to replica)
- **Connection Pool**: 32 children, 4 connections per child
- **Health Checks**: Every 5 seconds with 3 retries
- **Failover**: Disabled (use external orchestration for production failover)

The primary database is marked with `ALWAYS_PRIMARY|DISALLOW_TO_FAILOVER` to prevent accidental promotion of the replica. You should implement your own failover strategy for production use.

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

- The database uses named Docker volumes (`postgres-data`, `postgres-data-replica`) instead of bind mounts
- Data persists across container restarts on all platforms
- To reset the database completely, run: `docker compose down -v`
- Backups are stored in `postgres/dump/` on the host filesystem and survive volume deletions

### Replica Not Starting

If the read replica fails to start:

1. Check the replica logs: `docker compose logs postgres-replica`
2. Ensure the primary database is healthy: `docker compose ps`
3. The replica creates a replication slot on first startup - if this fails, you may need to recreate it:
   ```bash
   docker compose down
   docker volume rm mtgo-db_postgres-data-replica
   docker compose up -d
   ```

### Pgpool Connection Issues

If Pgpool-II is not routing queries correctly:

1. Check Pgpool logs: `docker compose logs pgpool`
2. Verify backend status: `docker compose exec pgpool psql -h localhost -p 9999 -U postgres -c "SHOW POOL_NODES;"`
3. Ensure both primary and replica are healthy before Pgpool starts

## License

This project is licensed under the [Apache-2.0 License](LICENSE).

## Advanced Usage

### Scaling Read Capacity

To add additional read replicas for higher read throughput:

1. Add a new replica service in `docker-compose.yml` (e.g., `postgres-replica-2`)
2. Add the new backend to Pgpool-II's environment variables
3. Increase the backend weight to distribute reads across multiple replicas

### Production Deployment

For production deployments:

1. **Change the default passwords**: Update `public_user` password in `postgres/public_user.sql`
2. **Enable SSL/TLS**: Configure PostgreSQL to require encrypted connections
3. **Set up monitoring**: Add health check endpoints and metrics exporters
4. **Configure failover**: Implement automatic failover with tools (e.g. [Patroni](https://github.com/patroni/patroni) or [repmgr](https://github.com/EnterpriseDB/repmgr))
5. **Backup redundancy**: Store backups in remote storage (S3, cloud storage, etc.)
6. **Resource limits**: Set appropriate memory and CPU limits in `docker-compose.yml`

### Monitoring Query Routing

To verify that queries are being routed correctly:

```bash
# View Pgpool statistics
docker compose exec pgpool psql -h localhost -p 9999 -U postgres -c "SHOW POOL_NODES;"

# Monitor query distribution
docker compose logs -f pgpool | grep "SELECT"
```

## Disclaimer

This project is not affiliated with Wizards of the Coast, Daybreak Games, or Magic: The Gathering Online. Magic: The Gathering Online (MTGO) is a trademark of Wizards of the Coast and is operated and published by Daybreak Games under license. All product names, trademarks, and registered trademarks are the property of their respective owners.
