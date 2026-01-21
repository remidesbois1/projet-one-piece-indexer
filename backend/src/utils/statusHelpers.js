const checkStatus = (pages) => {
    if (!pages || !pages.length) return 'empty';

    if (pages.every(p => p.statut === 'completed')) return 'completed';

    const hasActivity = pages.some(p => ['completed', 'in_progress', 'pending_review'].includes(p.statut));

    if (hasActivity) return 'in_progress';

    return 'empty';
};

module.exports = { checkStatus };
