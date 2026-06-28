function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseDescription(description) {
  if (!description) return {};
  if (typeof description === 'object') return description;
  try {
    return JSON.parse(description);
  } catch {
    return { content: String(description) };
  }
}

function buildPageEmbeddingText(pageOrDescription) {
  const source = pageOrDescription && Object.prototype.hasOwnProperty.call(pageOrDescription, 'description')
    ? pageOrDescription.description
    : pageOrDescription;
  const desc = parseDescription(source);
  const parts = [];

  if (desc.content) parts.push(desc.content);
  if (desc.metadata?.arc) parts.push(`Arc: ${desc.metadata.arc}`);
  if (Array.isArray(desc.metadata?.characters) && desc.metadata.characters.length) {
    parts.push(`Personnages: ${desc.metadata.characters.join(', ')}`);
  }

  const bubbles = pageOrDescription?.bulles;
  if (Array.isArray(bubbles)) {
    const bubbleText = bubbles
      .filter((bubble) => {
        const status = normalizeText(bubble.statut).toLowerCase();
        return bubble.texte_propose && (!status || ['validated', 'valid', 'valide', 'validée', 'validee'].includes(status));
      })
      .map((bubble) => bubble.texte_propose)
      .join(' ');
    if (bubbleText) parts.push(`Dialogues: ${bubbleText}`);
  }

  return normalizeText(parts.join(' '));
}

module.exports = {
  buildPageEmbeddingText,
  parseDescription,
};
