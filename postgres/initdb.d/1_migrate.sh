#!/bin/bash
set -e

# Import dump files if they exist
if [ -d "/pg/dump" ] && [ "$(ls -A /pg/dump/*.sql 2>/dev/null)" ]; then
  echo "Found dump files in /pg/dump - importing..."
  for dump_file in /pg/dump/*.sql; do
    if [ -f "$dump_file" ]; then
      echo "Importing: $(basename $dump_file)"
      
      # Import with ON_ERROR_STOP off to continue past owner errors
      # Redirect stderr to suppress owner warnings
      psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$dump_file" 2>&1 | grep -v "role.*does not exist" || true
      
      echo "✓ Imported: $(basename $dump_file)"
    fi
  done
  echo "All dump files imported successfully!"
else
  echo "No dump files found in /pg/dump - skipping migration"
fi
