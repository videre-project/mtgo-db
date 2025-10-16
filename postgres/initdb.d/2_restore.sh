#!/bin/bash
# Restore from latest backup if it exists
# This runs during initial database setup

BACKUP_FILE="/pg/dump/latest-backup.sql"

if [ -f "$BACKUP_FILE" ]; then
  echo "Found backup file, restoring database..."
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$BACKUP_FILE"
  echo "Database restored from backup"
else
  echo "No backup file found, starting with fresh database"
fi
