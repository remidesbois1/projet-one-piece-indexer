export const ANNEXE_AUTO_DELETE_THRESHOLD = 0.9;
export const SUMMARY_CANDIDATE_THRESHOLD = 0.8;

function probabilityFor(page, label) {
    const value = page.pageType?.probabilities?.[label];
    if (Number.isFinite(value)) return value;
    return page.pageType?.label === label ? page.pageType.confidence : 0;
}

function normalizeChapter(chapter, pageCount) {
    const number = Number.parseInt(chapter?.number, 10);
    const startPage = Number.parseInt(chapter?.startPage, 10);
    const title = typeof chapter?.title === 'string' ? chapter.title.trim() : '';
    if (!Number.isInteger(number) || number < 1) return null;
    if (!Number.isInteger(startPage) || startPage < 1 || startPage > pageCount) return null;
    return { number, startPage, title: title || `Chapitre ${number}` };
}

/**
 * Build the import proposal from the page-type model and the chapter list
 * extracted from the volume summary by Gemini. Covers are deliberately not a
 * chapter-boundary signal: only Gemini's validated summary positions are.
 */
export function buildPageTypeImportPlan(pages, summaryChapters = []) {
    const orderedPages = [...pages].sort((left, right) => left.index - right.index);
    const autoDeletedPages = orderedPages.filter(
        (page) => probabilityFor(page, 'annexe') > ANNEXE_AUTO_DELETE_THRESHOLD,
    );
    const summaryCandidates = orderedPages
        .map((page) => ({ page, confidence: probabilityFor(page, 'summary') }))
        .filter((candidate) => candidate.confidence >= SUMMARY_CANDIDATE_THRESHOLD)
        .sort((left, right) => right.confidence - left.confidence || left.page.index - right.page.index);
    const summaryPage = summaryCandidates[0]?.page || null;

    const excludedIds = new Set([
        ...autoDeletedPages.map((page) => page.id),
        ...summaryCandidates.map(({ page }) => page.id),
    ]);
    const retainedPages = orderedPages.filter((page) => !excludedIds.has(page.id));

    const normalizedChapters = summaryChapters
        .map((chapter) => normalizeChapter(chapter, orderedPages.length))
        .filter(Boolean)
        .sort((left, right) => left.startPage - right.startPage || left.number - right.number)
        .filter((chapter, index, all) => index === 0 || chapter.startPage !== all[index - 1].startPage);

    const chapters = normalizedChapters.map((chapter, index) => {
        const startIndex = chapter.startPage - 1;
        const nextChapter = normalizedChapters[index + 1];
        const nextStartIndex = nextChapter ? nextChapter.startPage - 1 : Number.POSITIVE_INFINITY;
        // Prefix pages (front cover, credits) remain with chapter one instead
        // of blocking the import as unassigned pages.
        const pageIds = retainedPages
            .filter((page) => (
                index === 0
                    ? page.index < nextStartIndex
                    : page.index >= startIndex && page.index < nextStartIndex
            ))
            .map((page) => page.id);
        return {
            chapterNumber: chapter.number,
            title: chapter.title,
            startPage: chapter.startPage,
            pageIds,
        };
    }).filter((chapter) => chapter.pageIds.length > 0);

    return {
        autoDeletedPages,
        summaryCandidates,
        summaryPage,
        retainedPages,
        chapters,
    };
}
