-- Migration: Stable UUID alignment for user_fragrances
-- Ensures that the nested 'id' field in the fragrance_data JSONB column matches the actual row ID UUID.

UPDATE public.user_fragrances 
SET fragrance_data = jsonb_set(fragrance_data, '{id}', to_jsonb(id::text));
