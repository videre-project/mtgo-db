CREATE INDEX IF NOT EXISTS idx_event_date ON Events (date);
CREATE INDEX IF NOT EXISTS idx_event_format ON Events (format);
CREATE INDEX IF NOT EXISTS idx_event_kind ON Events (kind);

CREATE INDEX IF NOT EXISTS idx_standing_player ON Standings (event_id, player);

CREATE INDEX IF NOT EXISTS idx_match_player ON Matches (event_id, player);
CREATE INDEX IF NOT EXISTS idx_match_opponent ON Matches (event_id, opponent);

CREATE INDEX IF NOT EXISTS idx_deck_player ON Decks (event_id, player);

-- CREATE UNIQUE index idx_archetype_deck_id ON Archetypes (deck_id);
-- CREATE index idx_archetype_archetype ON Archetypes (archetype);
-- CREATE index idx_archetype_archetype_id ON Archetypes (archetype_id);
DROP INDEX IF EXISTS idx_archetype_deck_id;
DROP INDEX IF EXISTS idx_archetype_archetype;
DROP INDEX IF EXISTS idx_archetype_archetype_id;

-- CREATE UNIQUE index idx_archetype_id ON Archetypes (id, archetype_id);

-- Card catalog indexes
CREATE INDEX IF NOT EXISTS idx_oracle_cards_name_trgm ON oracle_cards USING GIN (name_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_oracle_cards_search ON oracle_cards USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_oracle_cards_color_identity ON oracle_cards USING GIN (color_identity jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_oracle_cards_card_types ON oracle_cards USING GIN (card_types jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_oracle_cards_card_type_mask ON oracle_cards (card_type_mask);
CREATE INDEX IF NOT EXISTS idx_oracle_cards_color_identity_mask ON oracle_cards (color_identity_mask);
CREATE INDEX IF NOT EXISTS idx_oracle_cards_mana_value ON oracle_cards (mana_value);

CREATE INDEX IF NOT EXISTS idx_sets_name_trgm ON sets USING GIN (lower(coalesce(name, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_sets_release_date ON sets (release_date);
CREATE INDEX IF NOT EXISTS idx_sets_set_type ON sets (set_type);

CREATE INDEX IF NOT EXISTS idx_cards_oracle_id ON cards (oracle_id);
CREATE INDEX IF NOT EXISTS idx_cards_set_code ON cards (set_code);
CREATE INDEX IF NOT EXISTS idx_cards_name ON cards (name);
CREATE INDEX IF NOT EXISTS idx_cards_name_normalized ON cards (name_normalized);
CREATE INDEX IF NOT EXISTS idx_cards_name_trgm ON cards USING GIN (name_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cards_search ON cards USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_cards_type_line_trgm ON cards USING GIN (type_line gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cards_oracle_text_trgm ON cards USING GIN (oracle_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cards_artist_trgm ON cards USING GIN (lower(coalesce(artist, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cards_flavor_text_trgm ON cards USING GIN (lower(coalesce(flavor_text, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cards_collector_number ON cards (collector_number);
CREATE INDEX IF NOT EXISTS idx_cards_art_id ON cards (art_id);
CREATE INDEX IF NOT EXISTS idx_cards_frame_style ON cards (frame_style);
CREATE INDEX IF NOT EXISTS idx_cards_promo_label_trgm ON cards USING GIN (lower(coalesce(promo_label, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_cards_colors ON cards USING GIN (colors jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_cards_color_identity ON cards USING GIN (color_identity jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_cards_card_types ON cards USING GIN (card_types jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_cards_card_type_mask ON cards (card_type_mask);
CREATE INDEX IF NOT EXISTS idx_cards_supertypes ON cards USING GIN (supertypes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_cards_subtypes ON cards USING GIN (subtypes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_cards_color_mask ON cards (color_mask);
CREATE INDEX IF NOT EXISTS idx_cards_color_identity_mask ON cards (color_identity_mask);
CREATE INDEX IF NOT EXISTS idx_cards_oracle_id_non_token ON cards (oracle_id) WHERE coalesce(is_token, FALSE) = FALSE;
CREATE INDEX IF NOT EXISTS idx_cards_mana_value ON cards (mana_value);
CREATE INDEX IF NOT EXISTS idx_cards_mana_cost_normalized ON cards (lower(coalesce(mana_cost, '')));
CREATE INDEX IF NOT EXISTS idx_cards_power_numeric ON cards (api_numeric_text_value(power));
CREATE INDEX IF NOT EXISTS idx_cards_toughness_numeric ON cards (api_numeric_text_value(toughness));
CREATE INDEX IF NOT EXISTS idx_cards_loyalty_numeric ON cards (api_numeric_text_value(loyalty));
CREATE INDEX IF NOT EXISTS idx_cards_defense_numeric ON cards (api_numeric_text_value(defense));
CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards (rarity);
CREATE INDEX IF NOT EXISTS idx_cards_is_token ON cards (is_token);
CREATE INDEX IF NOT EXISTS idx_cards_split_parent_card_id ON cards (split_parent_card_id);
CREATE INDEX IF NOT EXISTS idx_cards_split_other_card_id ON cards (split_other_card_id);
CREATE INDEX IF NOT EXISTS idx_cards_split_search_order ON cards (name, set_code, collector_number, id)
WHERE (
  jsonb_array_length(split_card_ids) > 0
  OR split_parent_card_id IS NOT NULL
  OR split_other_card_id IS NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_set_code ON products (set_code);
CREATE INDEX IF NOT EXISTS idx_products_name ON products (name);
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING GIN (name_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_search ON products USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_products_object_type ON products (object_type);

CREATE INDEX IF NOT EXISTS idx_card_catalog_variants_card_id ON card_catalog_variants (card_id);
CREATE INDEX IF NOT EXISTS idx_card_catalog_variants_set_code ON card_catalog_variants (set_code);
CREATE INDEX IF NOT EXISTS idx_card_catalog_variants_name_trgm ON card_catalog_variants USING GIN (name_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_card_catalog_variants_type ON card_catalog_variants (variant_type);

CREATE INDEX IF NOT EXISTS idx_card_faces_source_catalog_id ON card_faces (source_catalog_id);
CREATE INDEX IF NOT EXISTS idx_card_faces_name_trgm ON card_faces USING GIN (name_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_card_faces_search ON card_faces USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_card_faces_type_line_trgm ON card_faces USING GIN (type_line gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_card_faces_oracle_text_trgm ON card_faces USING GIN (oracle_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_card_faces_artist_trgm ON card_faces USING GIN (lower(coalesce(artist, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_card_faces_flavor_text_trgm ON card_faces USING GIN (lower(coalesce(flavor_text, '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_card_faces_art_id ON card_faces (art_id);
CREATE INDEX IF NOT EXISTS idx_card_faces_multi ON card_faces (card_id, face_index);
CREATE INDEX IF NOT EXISTS idx_card_faces_colors ON card_faces USING GIN (colors jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_card_faces_card_types ON card_faces USING GIN (card_types jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_card_faces_card_type_mask ON card_faces (card_type_mask);
CREATE INDEX IF NOT EXISTS idx_card_faces_supertypes ON card_faces USING GIN (supertypes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_card_faces_subtypes ON card_faces USING GIN (subtypes jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_card_faces_mana_cost_normalized ON card_faces (lower(coalesce(mana_cost, '')));
CREATE INDEX IF NOT EXISTS idx_card_faces_power_numeric ON card_faces (api_numeric_text_value(power));
CREATE INDEX IF NOT EXISTS idx_card_faces_toughness_numeric ON card_faces (api_numeric_text_value(toughness));
CREATE INDEX IF NOT EXISTS idx_card_faces_loyalty_numeric ON card_faces (api_numeric_text_value(loyalty));
CREATE INDEX IF NOT EXISTS idx_card_faces_defense_numeric ON card_faces (api_numeric_text_value(defense));

CREATE INDEX IF NOT EXISTS idx_card_legalities_format_status ON card_legalities (format_code, status);
CREATE INDEX IF NOT EXISTS idx_card_legalities_format_status_oracle ON card_legalities (format_code, status, oracle_id);
