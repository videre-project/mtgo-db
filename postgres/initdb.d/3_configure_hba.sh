#!/bin/bash
# Configure pg_hba.conf to allow the passwordless public read-only SQL user.

HBA_FILE=$(psql -U "$POSTGRES_USER" -d postgres -t -c "SHOW hba_file;" | tr -d ' ')

if [[ -n "${API_PASSWORD:-}" ]]; then
    psql \
        -v ON_ERROR_STOP=1 \
        -U "$POSTGRES_USER" \
        -d postgres \
        --set=api_password="$API_PASSWORD" <<'SQL'
ALTER ROLE api WITH PASSWORD :'api_password';
SQL
else
    echo "API_PASSWORD is not set; api role keeps its existing password"
fi

# Add public_api trust authentication before the final scram-sha-256 rule
if ! grep -q "host all public_api" "$HBA_FILE"; then
    # Remove the last line (host all all all scram-sha-256)
    sed -i '/^host all all all scram-sha-256/d' "$HBA_FILE"
    
    # Add public_api trust auth and then the scram-sha-256 rule back.
    echo "# Allow passwordless public read-only SQL access." >> "$HBA_FILE"
    echo "# The public_api role owns read-only/timeout/resource guardrails." >> "$HBA_FILE"
    echo "host    all             public_api      0.0.0.0/0               trust" >> "$HBA_FILE"
    echo "# All other remote connections require password" >> "$HBA_FILE"
    echo "host    all             all             0.0.0.0/0               scram-sha-256" >> "$HBA_FILE"
    
    # Reload configuration
    psql -U "$POSTGRES_USER" -d postgres -c "SELECT pg_reload_conf();"
    
    echo "pg_hba.conf configured for passwordless public read-only SQL user"
fi
