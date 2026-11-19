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
            const material = data.status === 'material_only' ? text(data.selected_material).replaceAll('_', ' ') : '';
            const item = material ? `Looks like ${material}` : data.status === 'no_item' ? 'No waste item detected' : 'Item not confirmed';
            const message = human ? 'People and body parts do not go in any bin.' : material
                ? 'Exact item unclear. Do not use a bin based on material alone.' : 'Place one waste item in view and try again.';
            const score = data.material_probability ?? data.match_probability;
            return { item, bin: '', sourceBin: '', rules: [], checks: [message], tentative: false, withheld: true,
                matchScore: Number.isFinite(score) && score >= 0 && score <= 1 ? score : null,
                scoreLabel: material ? 'Model material score' : 'Model match score', reason: message, status: data.status,
                condition: text(data.observed?.condition?.choice) || 'Not returned', legacyCategory: 'Not used',
                score: Number.isFinite(score) ? String(score) : 'Not returned' };
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
        if (data.identity_uncertain) checks.push('Identity is tentative; verify the item.');
        if (data.special_handling) checks.push('Special handling required; follow the source instructions.');
        if (Array.isArray(data.clarification)) for (const value of data.clarification) {
            const question = typeof value === 'string' ? value : text(value?.question) || text(value?.id);
            if (question) checks.push(question);
        }
        if (['manual_review', 'needs_clarification'].includes(data.status)) checks.push('API requests manual review.');
        if (!bin) checks.push('No predicted policy bin was returned. Review the instructions; do not guess a bin.');
        const scoreValue = data.match_probability ?? legacy.confidence;
        const matchScore = Number.isFinite(scoreValue) && scoreValue >= 0 && scoreValue <= 1 ? scoreValue : null;
        return { item, bin, sourceBin, rules, checks, tentative: Boolean(data.identity_uncertain), matchScore,
            reason: text(data.reason), status: text(data.status) || 'Legacy response',
            condition: text(data.observed?.condition?.choice) || 'Not returned',
            legacyCategory: text(legacy.category) || 'Not returned',
            score: Number.isFinite(data.match_probability) ? String(data.match_probability) : 'Not returned' };
    }
    root.predictionInfo = predictionInfo;
})(typeof window === 'undefined' ? globalThis : window);
