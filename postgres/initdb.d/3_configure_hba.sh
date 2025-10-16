#!/bin/bash
# Configure pg_hba.conf to allow passwordless api user

HBA_FILE=$(psql -U "$POSTGRES_USER" -d postgres -t -c "SHOW hba_file;" | tr -d ' ')

# Add api user trust authentication before the final scram-sha-256 rule
if ! grep -q "host all api" "$HBA_FILE"; then
    # Remove the last line (host all all all scram-sha-256)
    sed -i '/^host all all all scram-sha-256/d' "$HBA_FILE"
    
    # Add api user trust auth and then the scram-sha-256 rule back
    echo "# Allow api user without password from anywhere (read-only access)" >> "$HBA_FILE"
    echo "host    all             api             0.0.0.0/0               trust" >> "$HBA_FILE"
    echo "# All other remote connections require password" >> "$HBA_FILE"
    echo "host    all             all             0.0.0.0/0               scram-sha-256" >> "$HBA_FILE"
    
    # Reload configuration
    psql -U "$POSTGRES_USER" -d postgres -c "SELECT pg_reload_conf();"
    
    echo "pg_hba.conf configured for passwordless api user"
fi
