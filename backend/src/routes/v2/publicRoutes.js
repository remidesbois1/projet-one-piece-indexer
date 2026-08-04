const express = require('express');

const { supabaseAdmin } = require('../../config/supabaseClient');
const { publicApiAccessMiddleware } = require('../../middleware/publicApiAccess');
const { VALIDATED_BUBBLE_STATUS, getPageImagePath } = require('../../utils/publicMedia');

const SERIES_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SERIES_SLUG_LENGTH = 100;
const MAX_RESOURCE_NUMBER = 100_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function parsePositiveInteger(value, name, { max = MAX_RESOURCE_NUMBER, fallback } = {}) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  if (Array.isArray(value) || !/^[1-9]\d*$/.test(String(value))) {
    const error = new Error(`${name} must be a positive integer.`);
    error.statusCode = 400;
    throw error;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    const error = new Error(`${name} is outside the supported range.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function parseSeriesSlug(value) {
  const slug = String(value || '');
  if (slug.length > MAX_SERIES_SLUG_LENGTH || !SERIES_SLUG_PATTERN.test(slug)) {
    const error = new Error('seriesSlug must be a lowercase URL slug.');
    error.statusCode = 400;
    throw error;
  }
  return slug;
}

function parsePagination(query = {}) {
  const page = parsePositiveInteger(query.page, 'page', { max: 1_000_000, fallback: 1 });
  const pageSize = parsePositiveInteger(query.page_size, 'page_size', {
    max: MAX_PAGE_SIZE,
    fallback: DEFAULT_PAGE_SIZE,
  });
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) {
    const error = new Error('pagination offset is outside the supported range.');
    error.statusCode = 400;
    throw error;
  }
  return { page, pageSize, from: offset, to: offset + pageSize - 1 };
}

function createPagination(req, { page, pageSize }, totalItems) {
  const safeTotal = Number.isSafeInteger(Number(totalItems)) && Number(totalItems) >= 0
    ? Number(totalItems)
    : 0;
  const totalPages = safeTotal === 0 ? 0 : Math.ceil(safeTotal / pageSize);
  const buildLink = (targetPage) => {
    if (!targetPage || targetPage < 1) return null;
    const params = new URLSearchParams({ page: String(targetPage), page_size: String(pageSize) });
    return `${req.baseUrl}${req.path}?${params.toString()}`;
  };
  return {
    pagination: {
      page,
      page_size: pageSize,
      total_items: safeTotal,
      total_pages: totalPages,
    },
    links: {
      self: buildLink(page),
      first: totalPages > 0 ? buildLink(1) : null,
      previous: page > 1 ? buildLink(page - 1) : null,
      next: page < totalPages ? buildLink(page + 1) : null,
      last: totalPages > 0 ? buildLink(totalPages) : null,
    },
  };
}

function createPublicV2Repository(client = supabaseAdmin) {
  return {
    async findVolume(seriesSlug, volumeNumber) {
      const { data, error } = await client
        .from('tomes')
        .select('id, numero, titre, mangas!inner(id, slug, titre, enabled)')
        .eq('numero', volumeNumber)
        .eq('mangas.slug', seriesSlug)
        .eq('mangas.enabled', true)
        .maybeSingle();
      if (error) throw error;
      return data;
    },

    async listChapters(volumeId, { from, to }) {
      const { data, error, count } = await client
        .from('chapitres')
        .select('id, numero, titre', { count: 'exact' })
        .eq('id_tome', volumeId)
        .order('numero', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to);
      if (error) throw error;
      return { rows: data || [], total: count || 0 };
    },

    async findPages(seriesSlug, chapterNumber, pageNumber) {
      const { data, error } = await client
        .from('pages')
        .select(`
          id,
          numero_page,
          description,
          chapitres!inner(
            id,
            numero,
            titre,
            tomes!inner(
              id,
              numero,
              titre,
              mangas!inner(id, slug, titre, enabled)
            )
          )
        `)
        .eq('numero_page', pageNumber)
        .eq('chapitres.numero', chapterNumber)
        .eq('chapitres.tomes.mangas.slug', seriesSlug)
        .eq('chapitres.tomes.mangas.enabled', true)
        .order('id', { ascending: true })
        .limit(2);
      if (error) throw error;
      return data || [];
    },

    async listBubbles(pageId, { from, to }) {
      const { data, error, count } = await client
        .from('bulles')
        .select('id, texte_propose, order', { count: 'exact' })
        .eq('id_page', pageId)
        .eq('statut', VALIDATED_BUBBLE_STATUS)
        .not('texte_propose', 'is', null)
        .neq('texte_propose', '')
        .order('order', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to);
      if (error) throw error;
      return { rows: data || [], total: count || 0 };
    },
  };
}

function getPublicMetadata(description) {
  try {
    const parsed = typeof description === 'string' ? JSON.parse(description) : description;
    const metadata = parsed?.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { arc: null, characters: [] };
    return {
      arc: typeof metadata.arc === 'string' ? metadata.arc.slice(0, 200) : null,
      characters: Array.isArray(metadata.characters)
        ? metadata.characters.filter((value) => typeof value === 'string').slice(0, 100).map((value) => value.slice(0, 200))
        : [],
    };
  } catch {
    return { arc: null, characters: [] };
  }
}

function createPublicV2Router({
  repository = createPublicV2Repository(),
  accessMiddleware = publicApiAccessMiddleware,
} = {}) {
  const router = express.Router();
  router.use(accessMiddleware);

  router.get('/series/:seriesSlug/volumes/:volumeNumber/chapters', async (req, res) => {
    try {
      const seriesSlug = parseSeriesSlug(req.params.seriesSlug);
      const volumeNumber = parsePositiveInteger(req.params.volumeNumber, 'volumeNumber');
      const pagination = parsePagination(req.query);
      const volume = await repository.findVolume(seriesSlug, volumeNumber);
      if (!volume) return res.status(404).json({ error: 'Volume not found.' });

      const chapters = await repository.listChapters(volume.id, pagination);
      const series = volume.mangas;
      const pageMetadata = createPagination(req, pagination, chapters.total);
      return res.json({
        series: {
          id: series.id,
          slug: series.slug,
          title: series.titre,
        },
        volume: {
          id: volume.id,
          number: volume.numero,
          title: volume.titre,
          series_id: series.id,
          series_slug: series.slug,
        },
        data: chapters.rows.map((chapter) => ({
          id: chapter.id,
          series_id: series.id,
          series_slug: series.slug,
          volume_id: volume.id,
          volume_number: volume.numero,
          chapter_number: chapter.numero,
          title: chapter.titre,
        })),
        ...pageMetadata,
      });
    } catch (error) {
      if (error?.statusCode === 400) return res.status(400).json({ error: error.message });
      console.error('[Public API v2] Chapter listing failed.');
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.get('/series/:seriesSlug/chapters/:chapterNumber/pages/:pageNumber', async (req, res) => {
    try {
      const seriesSlug = parseSeriesSlug(req.params.seriesSlug);
      const chapterNumber = parsePositiveInteger(req.params.chapterNumber, 'chapterNumber');
      const pageNumber = parsePositiveInteger(req.params.pageNumber, 'pageNumber');
      const pagination = parsePagination(req.query);
      const pages = await repository.findPages(seriesSlug, chapterNumber, pageNumber);
      if (pages.length === 0) return res.status(404).json({ error: 'Page not found.' });
      if (pages.length > 1) {
        return res.status(409).json({
          error: 'Chapter number is ambiguous inside this series.',
          code: 'AMBIGUOUS_CHAPTER_NUMBER',
        });
      }

      const page = pages[0];
      const chapter = page.chapitres;
      const volume = chapter.tomes;
      const series = volume.mangas;
      const bubbles = await repository.listBubbles(page.id, pagination);
      const pageMetadata = createPagination(req, pagination, bubbles.total);
      return res.json({
        data: {
          id: page.id,
          series_id: series.id,
          series_slug: series.slug,
          volume_id: volume.id,
          volume_number: volume.numero,
          chapter_id: chapter.id,
          chapter_number: chapter.numero,
          page_number: page.numero_page,
          image_url: getPageImagePath(page.id),
          metadata: getPublicMetadata(page.description),
          bubbles: bubbles.rows.map((bubble) => ({
            id: bubble.id,
            content: bubble.texte_propose,
            order: bubble.order,
          })),
        },
        ...pageMetadata,
      });
    } catch (error) {
      if (error?.statusCode === 400) return res.status(400).json({ error: error.message });
      console.error('[Public API v2] Page lookup failed.');
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  return router;
}

const router = createPublicV2Router();

module.exports = router;
module.exports.createPagination = createPagination;
module.exports.createPublicV2Repository = createPublicV2Repository;
module.exports.createPublicV2Router = createPublicV2Router;
module.exports.parsePagination = parsePagination;
module.exports.parsePositiveInteger = parsePositiveInteger;
module.exports.parseSeriesSlug = parseSeriesSlug;
