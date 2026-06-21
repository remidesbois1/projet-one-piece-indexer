const STOP_WORDS = new Set([
  'alors', 'apres', 'assez', 'avec', 'avoir', 'cette', 'dans', 'des', 'donc',
  'elle', 'elles', 'encore', 'etre', 'fait', 'font', 'mais', 'meme', 'nous',
  'pour', 'plus', 'quoi', 'sans', 'sont', 'suis', 'tout', 'tous', 'tres',
  'vous', 'votre', 'notre', 'leur', 'leurs', 'mon', 'mes', 'tes', 'ses', 'les',
  'une', 'que', 'qui', 'est', 'pas', 'sur', 'aux', 'ce', 'ces', 'ils', 'toi',
  'moi', 'lui', 'peu', 'deja'
]);

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[œ]/g, 'oe')
    .replace(/[æ]/g, 'ae')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeOcrSkeleton(value) {
  return normalizeText(value)
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w');
}

function tokenize(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .filter(token => token.length >= 2 && !STOP_WORDS.has(token));
}

function uniqueTokens(value) {
  return Array.from(new Set(tokenize(value)));
}

function diceCoefficient(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  }
  if (a.length < 3 || b.length < 3) return 0;

  const grams = (text) => {
    const result = new Map();
    for (let i = 0; i < text.length - 1; i += 1) {
      const gram = text.slice(i, i + 2);
      result.set(gram, (result.get(gram) || 0) + 1);
    }
    return result;
  };

  const aGrams = grams(a);
  const bGrams = grams(b);
  let overlap = 0;
  let total = 0;

  for (const count of aGrams.values()) total += count;
  for (const count of bGrams.values()) total += count;

  for (const [gram, count] of aGrams) {
    overlap += Math.min(count, bGrams.get(gram) || 0);
  }

  return total ? (2 * overlap) / total : 0;
}

function compactOcrText(value) {
  return normalizeOcrSkeleton(value).replace(/\s+/g, '');
}

function boundedEditDistance(a, b, maxDistance = 6) {
  if (a === b) return 0;
  if (!a || !b) return Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = current[j - 1] + 1;
      const deletion = previous[j] + 1;
      current[j] = Math.min(substitution, insertion, deletion);
      rowMin = Math.min(rowMin, current[j]);
    }

    if (rowMin > maxDistance) return maxDistance + 1;
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

function strictCharacterScore(a, b, maxBadChars = 6) {
  const left = compactOcrText(a);
  const right = compactOcrText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  if (left.includes(right) || right.includes(left)) {
    const extraChars = Math.max(left.length, right.length) - Math.min(left.length, right.length);
    if (extraChars > maxBadChars) return 0;
    return Math.max(0, 1 - (extraChars / Math.max(left.length, right.length)) * 1.35);
  }

  const distance = boundedEditDistance(left, right, maxBadChars);
  if (distance > maxBadChars) return 0;

  const length = Math.max(left.length, right.length);
  const rawScore = 1 - distance / Math.max(1, length);
  const penalty = distance >= 4 ? 0.08 : 0;
  return Math.max(0, rawScore - penalty);
}

function tokenSimilarity(queryTokens, candidateTokens) {
  if (!queryTokens.length || !candidateTokens.length) return 0;

  let weightedScore = 0;
  let totalWeight = 0;

  for (const queryToken of queryTokens) {
    const querySkeleton = normalizeOcrSkeleton(queryToken);
    const weight = Math.min(2.5, Math.max(1, queryToken.length / 4));
    let best = 0;

    for (const candidateToken of candidateTokens) {
      const candidateSkeleton = normalizeOcrSkeleton(candidateToken);
      if (queryToken === candidateToken || querySkeleton === candidateSkeleton) {
        best = 1;
        break;
      }
      best = Math.max(
        best,
        diceCoefficient(queryToken, candidateToken),
        diceCoefficient(querySkeleton, candidateSkeleton) * 0.94
      );
    }

    weightedScore += best * weight;
    totalWeight += weight;
  }

  return totalWeight ? weightedScore / totalWeight : 0;
}

function textSimilarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const characterScore = strictCharacterScore(left, right);
  if (characterScore <= 0) return 0;

  const queryTokens = uniqueTokens(left);
  const candidateTokens = uniqueTokens(right);
  const tokenScore = tokenSimilarity(queryTokens, candidateTokens);
  const charScore = diceCoefficient(compactOcrText(left), compactOcrText(right));

  return Math.min(characterScore, tokenScore * 0.40 + charScore * 0.20 + characterScore * 0.40);
}

function normalizeBBox(raw) {
  if (!raw) return null;

  let x1;
  let y1;
  let x2;
  let y2;

  if (Array.isArray(raw)) {
    [x1, y1, x2, y2] = raw.map(Number);
  } else if (typeof raw === 'object') {
    if (raw.x1 !== undefined || raw.y1 !== undefined || raw.x2 !== undefined || raw.y2 !== undefined) {
      x1 = Number(raw.x1);
      y1 = Number(raw.y1);
      x2 = Number(raw.x2);
      y2 = Number(raw.y2);
    } else {
      x1 = Number(raw.x);
      y1 = Number(raw.y);
      x2 = x1 + Number(raw.w);
      y2 = y1 + Number(raw.h);
    }
  }

  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];

  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  if (!w || !h) return null;

  return {
    x1,
    y1,
    x2,
    y2,
    w,
    h,
    cx: x1 + w / 2,
    cy: y1 + h / 2,
  };
}

function normalizeQueryBubbles(input) {
  return (Array.isArray(input) ? input : [])
    .map((bubble, index) => {
      const content = String(bubble?.content || bubble?.text || bubble?.texte_propose || '').trim();
      const bbox = normalizeBBox(bubble?.bbox || bubble?.pos || bubble);
      const tokens = uniqueTokens(content);
      return {
        index,
        content,
        bbox,
        tokens,
        weight: Math.max(1, Math.min(4, Math.sqrt(Math.max(content.length, tokens.join('').length)) / 3)),
      };
    })
    .filter(bubble => bubble.content || bubble.bbox);
}

function normalizePageBubble(bubble) {
  const content = String(bubble?.texte_propose || bubble?.content || '').trim();
  return {
    id: bubble.id,
    page_id: bubble.id_page || bubble.page_id,
    content,
    bbox: normalizeBBox(bubble),
    order: bubble.order ?? null,
    tokens: uniqueTokens(content),
  };
}

function buildInformativeTokens(queryBubbles, maxTokens = 12) {
  const counts = new Map();
  for (const bubble of queryBubbles) {
    for (const token of bubble.tokens) {
      if (token.length < 3 || STOP_WORDS.has(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => {
      const rarity = a[1] - b[1];
      if (rarity !== 0) return rarity;
      return b[0].length - a[0].length;
    })
    .slice(0, maxTokens)
    .map(([token]) => token);
}

function tokenLookupTerms(token) {
  const normalized = normalizeText(token).replace(/\s+/g, '');
  const skeleton = normalizeOcrSkeleton(token).replace(/\s+/g, '');
  const terms = new Map();

  const add = (term, weight) => {
    if (!term || term.length < 3 || STOP_WORDS.has(term)) return;
    terms.set(term, Math.max(terms.get(term) || 0, weight));
  };

  add(normalized, Math.max(1, normalized.length / 5));
  add(skeleton, Math.max(0.85, skeleton.length / 6));

  for (const value of new Set([normalized, skeleton])) {
    if (value.length >= 6) {
      const windowSize = value.length >= 9 ? 5 : 4;
      for (let i = 0; i <= value.length - windowSize; i += 1) {
        add(value.slice(i, i + windowSize), 0.45);
      }
    }
  }

  return Array.from(terms.entries()).map(([term, weight]) => ({ term, weight }));
}

function buildCandidateTokenQueries(queryBubbles, maxTokens = 12) {
  const queries = new Map();
  const informativeTokens = buildInformativeTokens(queryBubbles, maxTokens);

  informativeTokens.forEach((token, tokenIndex) => {
    const tokenPriority = Math.max(0.35, 1 - tokenIndex / Math.max(1, maxTokens));
    for (const { term, weight } of tokenLookupTerms(token)) {
      queries.set(term, Math.max(queries.get(term) || 0, weight * tokenPriority));
    }
  });

  return Array.from(queries.entries())
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([term, weight]) => ({ term, weight }));
}

function scoreBubblePairs(queryBubbles, pageBubbles) {
  const pairs = [];
  const usedPageBubbleIds = new Set();

  const candidatePairs = [];
  for (const queryBubble of queryBubbles) {
    if (!queryBubble.content) continue;
    for (const pageBubble of pageBubbles) {
      if (!pageBubble.content) continue;
      const score = textSimilarity(queryBubble.content, pageBubble.content);
      if (score >= 0.62) {
        candidatePairs.push({ queryBubble, pageBubble, textScore: score });
      }
    }
  }

  candidatePairs.sort((a, b) => b.textScore - a.textScore);

  for (const pair of candidatePairs) {
    if (usedPageBubbleIds.has(pair.pageBubble.id)) continue;
    if (pairs.some(existing => existing.queryBubble.index === pair.queryBubble.index)) continue;
    usedPageBubbleIds.add(pair.pageBubble.id);
    pairs.push(pair);
  }

  return pairs.sort((a, b) => a.queryBubble.index - b.queryBubble.index);
}

function normalizePointCloud(items, getBBox) {
  const boxes = items.map(getBBox).filter(Boolean);
  if (boxes.length < 2) return new Map();

  const minX = Math.min(...boxes.map(box => box.cx));
  const maxX = Math.max(...boxes.map(box => box.cx));
  const minY = Math.min(...boxes.map(box => box.cy));
  const maxY = Math.max(...boxes.map(box => box.cy));
  const rangeX = Math.max(1, maxX - minX);
  const rangeY = Math.max(1, maxY - minY);
  const result = new Map();

  for (const item of items) {
    const box = getBBox(item);
    if (!box) continue;
    result.set(item, {
      x: (box.cx - minX) / rangeX,
      y: (box.cy - minY) / rangeY,
    });
  }

  return result;
}

function layoutSimilarity(pairs) {
  const usablePairs = pairs.filter(pair => pair.queryBubble.bbox && pair.pageBubble.bbox && pair.textScore >= 0.70);
  if (usablePairs.length < 2) return 0;

  const queryCloud = normalizePointCloud(usablePairs, pair => pair.queryBubble.bbox);
  const pageCloud = normalizePointCloud(usablePairs, pair => pair.pageBubble.bbox);
  let distanceScore = 0;
  let count = 0;

  for (const pair of usablePairs) {
    const queryPoint = queryCloud.get(pair);
    const pagePoint = pageCloud.get(pair);
    if (!queryPoint || !pagePoint) continue;
    const distance = Math.hypot(queryPoint.x - pagePoint.x, queryPoint.y - pagePoint.y) / Math.SQRT2;
    distanceScore += Math.max(0, 1 - distance);
    count += 1;
  }

  if (!count) return 0;

  let orderMatches = 0;
  let orderComparisons = 0;
  for (let i = 0; i < usablePairs.length; i += 1) {
    for (let j = i + 1; j < usablePairs.length; j += 1) {
      const a = usablePairs[i];
      const b = usablePairs[j];
      const queryDirection = Math.sign((a.queryBubble.bbox.cy - b.queryBubble.bbox.cy) * 1.4 || (b.queryBubble.bbox.cx - a.queryBubble.bbox.cx));
      const pageDirection = Math.sign((a.pageBubble.bbox.cy - b.pageBubble.bbox.cy) * 1.4 || (b.pageBubble.bbox.cx - a.pageBubble.bbox.cx));
      if (queryDirection && pageDirection) {
        orderComparisons += 1;
        if (queryDirection === pageDirection) orderMatches += 1;
      }
    }
  }

  const orderScore = orderComparisons ? orderMatches / orderComparisons : 0.5;
  return (distanceScore / count) * 0.65 + orderScore * 0.35;
}

function scorePageCandidate(queryBubbles, pageRecord) {
  const rawPageBubbles = pageRecord.bubbles || pageRecord.bulles || [];
  const pageBubbles = rawPageBubbles.map(normalizePageBubble).filter(bubble => bubble.content);
  if (!queryBubbles.length || !pageBubbles.length) return null;

  const pairs = scoreBubblePairs(queryBubbles, pageBubbles);
  if (!pairs.length) return null;

  let weightedTextScore = 0;
  let totalWeight = 0;

  for (const queryBubble of queryBubbles) {
    const pair = pairs.find(item => item.queryBubble.index === queryBubble.index);
    const score = pair ? pair.textScore : 0;
    weightedTextScore += score * queryBubble.weight;
    totalWeight += queryBubble.weight;
  }

  const textScore = totalWeight ? weightedTextScore / totalWeight : 0;
  const matchedCount = pairs.filter(pair => pair.textScore >= 0.70).length;
  const coverageScore = queryBubbles.length ? matchedCount / queryBubbles.length : 0;
  const layoutScore = layoutSimilarity(pairs);
  const densityPenalty = Math.max(0.72, Math.min(1, 1.18 - pageBubbles.length / 65));
  const certaintyTextScore = Math.pow(textScore, 1.45);
  const certaintyCoverageScore = Math.pow(coverageScore, 1.35);
  const finalScore = Math.max(0, Math.min(1, (
    certaintyTextScore * 0.78 +
    certaintyCoverageScore * 0.15 +
    layoutScore * 0.07
  ) * densityPenalty));

  if (finalScore < 0.50) return null;

  const bestPairs = pairs
    .filter(pair => pair.textScore >= 0.62)
    .slice(0, 6)
    .map(pair => ({
      query_index: pair.queryBubble.index,
      query_text: pair.queryBubble.content,
      matched_text: pair.pageBubble.content,
      bubble_id: pair.pageBubble.id,
      score: Number(pair.textScore.toFixed(3)),
      coords: pair.pageBubble.bbox
        ? {
          x: Math.round(pair.pageBubble.bbox.x1),
          y: Math.round(pair.pageBubble.bbox.y1),
          w: Math.round(pair.pageBubble.bbox.w),
          h: Math.round(pair.pageBubble.bbox.h),
        }
        : null,
    }));

  return {
    ...pageRecord,
    score: finalScore,
    scoreBreakdown: {
      text: textScore,
      coverage: coverageScore,
      layout: layoutScore,
      matched_count: matchedCount,
      query_count: queryBubbles.length,
    },
    matches: bestPairs,
  };
}

function rankOcrPageCandidates(queryBubblesInput, pageRecords, options = {}) {
  const queryBubbles = normalizeQueryBubbles(queryBubblesInput);
  const limit = Number(options.limit) || 24;

  return (Array.isArray(pageRecords) ? pageRecords : [])
    .map(pageRecord => scorePageCandidate(queryBubbles, pageRecord))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = {
  buildCandidateTokenQueries,
  buildInformativeTokens,
  normalizeOcrSkeleton,
  normalizeQueryBubbles,
  normalizeText,
  rankOcrPageCandidates,
  scorePageCandidate,
  textSimilarity,
  tokenize,
};
