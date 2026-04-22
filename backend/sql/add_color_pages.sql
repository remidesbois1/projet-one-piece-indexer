-- Migration: Add color page variant support
-- Date: 2026-04-15

-- Add color variant columns to pages table
ALTER TABLE public.pages
  ADD COLUMN IF NOT EXISTS url_image_color text,
  ADD COLUMN IF NOT EXISTS color_crop_data jsonb,
  ADD COLUMN IF NOT EXISTS color_validated boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS color_source_pages jsonb;

COMMENT ON COLUMN public.pages.url_image_color IS 'R2 URL of the color variant (nullable = no color variant)';
COMMENT ON COLUMN public.pages.color_crop_data IS 'Alignment transform data: {affine: [a00,a01,a10,a11,tx,ty], manual_offset_x, manual_offset_y}';
COMMENT ON COLUMN public.pages.color_validated IS 'Admin has validated the color alignment';
COMMENT ON COLUMN public.pages.color_source_pages IS 'Source tracking: [{cbz_index, filename}] for color pages (useful when 2 pages are merged into 1 spread)';
