/* Exact API information, independent of the legacy Not accepted display sentinel. */
(function (root) {
    const text = value => typeof value === 'string' ? value : '';
    function knownBin(value) {
        const category = text(value).trim();
        return /^(blue bin(?: \(recycling\))?|green bin(?: \(organics\))?|garbage(?: bin)?|recycling|metal|compost|organic|hhw|household hazardous waste|electronic waste)$/i.test(category) ? category : '';
    }
    function predictionInfo(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw new Error('Invalid prediction response');
        const legacy = data.results?.[0] || {};
        // An older Worker might still include a candidate bin on a rejected match.
        const withheld = ['no_item', 'material_only'].includes(data.status) || data.identity_uncertain === true ||
            (['manual_review', 'needs_clarification'].includes(data.status) && !text(data.selected_item));
        if (withheld) {
            const human = data.status === 'no_item' && data.no_item_reason === 'human_only';
            const item = data.status === 'no_item' ? 'No waste item detected' : 'Item not confirmed';
            const message = human ? 'People and body parts do not go in any bin.' : 'Place one waste item in view and try again.';
            const subject = data.observed?.subject;
            const match = data.observed?.match;
            // Show the score behind the outcome: the no-item vote, the "none fits"
            // vote, or the best candidate's score that fell below the threshold.
            const p = data.status === 'no_item' ? (data.no_item_reason && subject?.choice === data.no_item_reason ? subject.p : null)
                : match?.choice === 'none' ? match.p
                : Number.isFinite(data.match_probability) ? data.match_probability
                : ['unknown','multiple_items'].includes(subject?.choice) ? subject.p : null;
            return { item, bin: '', sourceBin: '', rules: [], checks: [message], tentative: false, withheld: true,
                matchScore: Number.isFinite(p) && p >= 0 && p <= 1 ? p : null, reason: message, status: data.status,
                condition: text(data.observed?.condition?.choice) || 'Not returned', legacyCategory: 'Not used',
                score: Number.isFinite(data.match_probability) ? String(data.match_probability) : 'Not returned' };
        }
        const item = text(data.selected_item) || text(legacy.item) || text(data.item_name) || text(data.source_items?.[0]);
        if (!item) throw new Error('Invalid prediction: missing identified item');
        // Modern policy labels are shown verbatim, including depot/special destinations.
        // Only legacy fallbacks need an allowlist to avoid treating a sentinel as a bin.
        const bin = text(data.policy_category).trim() || text(data.proposed_category).trim() || knownBin(data.category) || knownBin(legacy.category);
        const sourceBin = text(data.source_category) || bin || 'No policy bin returned';
        const rules = Array.isArray(data.rule_evaluation) && data.rule_evaluation.length
            ? data.rule_evaluation.filter(rule => rule && typeof rule.text === 'string').map(rule => ({ text: rule.text, state: ['applies', 'does_not_apply', 'check', 'reference'].includes(rule.state) ? rule.state : 'reference' }))
            : (Array.isArray(data.instructions) ? data.instructions.filter(value => typeof value === 'string').map(value => ({ text: value, state: 'reference' })) : []);
        if (!rules.length) {
            const instruction = text(legacy.instruction) || text(data.instruction);
            if (instruction) rules.push({ text: instruction, state: 'reference' });
        }
        const checks = [];
        if (data.identity_uncertain || data.tentative_match === true) {
            checks.push('Tentative match: below the 80% confidence threshold. Check the item before using this bin.');
            // Contenders help the person correct a close call; names and scores only, no bins.
            const others = (Array.isArray(data.alternatives) ? data.alternatives : [])
                .filter(alt => text(alt?.item) && Number.isFinite(alt.probability) && alt.probability >= 0.01 && alt.probability <= 1)
                .slice(0, 3).map(alt => `${alt.item} ${Math.round(alt.probability * 100)}%`);
            if (others.length) checks.push(`Other possibilities: ${others.join(' · ')}`);
            if (Number.isFinite(data.match_probability) && data.match_probability < 0.3) {
                checks.push('Low confidence: this may be a guess. Retake with the item filling the frame, well lit and not covered by your hand.');
            }
        }
        if (data.special_handling) checks.push('Special handling required; follow the source instructions.');
        if (Array.isArray(data.clarification)) for (const value of data.clarification) {
            const question = typeof value === 'string' ? value : text(value?.question) || text(value?.id);
            if (question) checks.push(question);
        }
        if (['manual_review', 'needs_clarification'].includes(data.status)) checks.push('API requests manual review.');
        if (!bin) checks.push('No predicted policy bin was returned. Review the instructions; do not guess a bin.');
        const scoreValue = data.match_probability ?? legacy.confidence;
        const matchScore = Number.isFinite(scoreValue) && scoreValue >= 0 && scoreValue <= 1 ? scoreValue : null;
        return { item, bin, sourceBin, rules, checks, tentative: Boolean(data.identity_uncertain || data.tentative_match === true), matchScore,
            reason: text(data.reason), status: text(data.status) || 'Legacy response',
            condition: text(data.observed?.condition?.choice) || 'Not returned',
            legacyCategory: text(legacy.category) || 'Not returned',
            score: Number.isFinite(data.match_probability) ? String(data.match_probability) : 'Not returned' };
    }
    function formatModelConfidence(score) {
        if (!Number.isFinite(score) || score < 0 || score > 1) return 'Model confidence: unavailable';
        if (score === 1) return 'Model confidence: 100%';
        const percent = Number((score * 100).toFixed(1));
        return `Model confidence: ${percent === 100 ? '>99.9%' : `${percent}%`}`;
    }
    root.predictionInfo = predictionInfo;
    root.formatModelConfidence = formatModelConfidence;
})(typeof window === 'undefined' ? globalThis : window);
