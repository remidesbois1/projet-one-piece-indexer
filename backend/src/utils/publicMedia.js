const VALIDATED_BUBBLE_STATUS = 'Validé';

function getPageImagePath(pageId) {
  if (pageId === null || pageId === undefined || pageId === '') return null;
  return `/api/pages/${encodeURIComponent(String(pageId))}/image`;
}

function toPageDto(page, { authenticated = false } = {}) {
  const dto = {
    id: page.id,
    numero_page: page.numero_page,
    url_image: getPageImagePath(page.id),
  };

  if (page.chapitres !== undefined) dto.chapitres = page.chapitres;

  if (authenticated) {
    for (const field of [
      'id_chapitre',
      'statut',
      'description',
      'commentaire_moderation',
    ]) {
      if (page[field] !== undefined) dto[field] = page[field];
    }
  }

  return dto;
}

function toPublicBubbleDto(bubble) {
  return {
    id: bubble.id,
    x: bubble.x,
    y: bubble.y,
    w: bubble.w,
    h: bubble.h,
    texte_propose: bubble.texte_propose,
    order: bubble.order,
  };
}

async function keepValidatedBubbleRows(client, rows, { chunkSize = 500 } = {}) {
  const candidates = Array.isArray(rows) ? rows : [];
  const ids = candidates.map((row) => row?.id).filter((id) => id !== null && id !== undefined);
  if (ids.length === 0) return [];

  const validatedIds = new Set();
  for (let start = 0; start < ids.length; start += chunkSize) {
    const chunk = ids.slice(start, start + chunkSize);
    const { data, error } = await client
      .from('bulles')
      .select('id')
      .eq('statut', VALIDATED_BUBBLE_STATUS)
      .in('id', chunk);

    if (error) throw error;
    for (const row of data || []) validatedIds.add(row.id);
  }

  return candidates.filter((row) => validatedIds.has(row.id));
}

module.exports = {
  VALIDATED_BUBBLE_STATUS,
  getPageImagePath,
  keepValidatedBubbleRows,
  toPageDto,
  toPublicBubbleDto,
};
