/* Shared English/French interface text for the kiosk and web demo.
   English strings are the keys. Waste Wizard item names and source
   instructions are official English catalog text and pass through unchanged. */
(function (root) {
    'use strict';
    const FR = {
        // Start screen (kiosk)
        'Take Photo': 'Prendre une photo',
        'Upload Photo': 'Téléverser une photo',
        'High Contrast': 'Contraste élevé',
        'How to Use': 'Mode d’emploi',
        '1. Position item in camera view': '1. Placez l’objet devant la caméra',
        '2. Wait for automatic capture': '2. Attendez la capture automatique',
        '3. View classification results': '3. Consultez le résultat',
        'Camera not available': 'Caméra non disponible',
        'Camera requires HTTPS. Use file upload instead.': 'La caméra exige HTTPS. Téléversez plutôt un fichier.',
        // Scanning and result screens
        'Analyzing your item...': 'Analyse de votre objet…',
        'How Long It Took Benny To Process Your Query:': 'Temps de traitement de Benny :',
        '← Scan Another Item': '← Analyser un autre objet',
        'Close photo ×': 'Fermer la photo ×',
        'Full response': 'Réponse complète',
        'Model confidence is not calibrated certainty.': 'La confiance du modèle n’est pas une certitude calibrée.',
        'Model confidence: {value}': 'Confiance du modèle : {value}',
        'unavailable': 'non disponible',
        'PREDICTED POLICY BIN': 'BAC PRÉVU',
        'NO WASTE ITEM': 'AUCUN DÉCHET',
        'NO BIN RECOMMENDATION': 'AUCUN BAC RECOMMANDÉ',
        'NOT CONFIRMED': 'NON CONFIRMÉ',
        'Predicted policy bin — not an automatic sorting confirmation. Follow all source conditions.':
            'Bac prévu selon les règles — pas une confirmation de tri automatique. Respectez toutes les conditions indiquées.',
        'No bin recommendation was made.': 'Aucun bac n’a été recommandé.',
        'What to do next': 'Que faire ensuite',
        'Source instructions — {bin}': 'Consignes officielles — {bin}',
        'No source instructions': 'Aucune consigne officielle',
        'No instruction is confirmed to apply. Review the API details before disposal.':
            'Aucune consigne n’est confirmée. Vérifiez les détails avant de jeter l’objet.',
        'No source instructions returned by the API.': 'Aucune consigne officielle reçue.',
        'No waste item detected': 'Aucun déchet détecté',
        'Item not confirmed': 'Objet non confirmé',
        'People and body parts do not go in any bin.': 'Les personnes et les parties du corps ne vont dans aucun bac.',
        'Place one waste item in view and try again.': 'Placez un seul déchet devant la caméra et réessayez.',
        'Other possibilities: {list}': 'Autres possibilités : {list}',
        'Special handling required; follow the source instructions.': 'Manipulation spéciale requise; suivez les consignes officielles.',
        'API requests manual review.': 'Vérification manuelle demandée.',
        'No predicted policy bin was returned. Review the instructions; do not guess a bin.':
            'Aucun bac prévu. Consultez les consignes; ne devinez pas le bac.',
        'Submitted photo · {size} bytes': 'Photo soumise · {size} octets',
        // Errors
        'Unable to identify item': 'Objet non identifié',
        'No usable prediction was returned. Try another photo; do not guess a bin.':
            'Aucune prédiction utilisable. Essayez une autre photo; ne devinez pas le bac.',
        'TRY AGAIN': 'RÉESSAYER',
        'Error: {message}': 'Erreur : {message}',
        'The scan timed out. Please try again.': 'L’analyse a expiré. Veuillez réessayer.',
        'The camera did not return a photo. Please try again.': 'La caméra n’a pas fourni de photo. Veuillez réessayer.',
        'Too many analyses. Please wait one minute.': 'Trop d’analyses. Veuillez patienter une minute.',
        'Demo is busy. Please wait one minute.': 'La démo est occupée. Veuillez patienter une minute.',
        'An image is already being processed. Please retry shortly.': 'Une image est déjà en cours de traitement. Réessayez dans un instant.',
        // Web demo
        'Benny · Web demo': 'Benny · Démo web',
        'What are you sorting?': 'Que voulez-vous trier?',
        'Take a photo, choose one, or paste an image (Ctrl+V) to check it against the Waste Wizard catalog.':
            'Prenez une photo, choisissez-en une ou collez une image (Ctrl+V) pour la comparer au catalogue Waste Wizard.',
        'Choose a photo': 'Choisir une photo',
        'Capture photo': 'Prendre la photo',
        'Close camera': 'Fermer la caméra',
        'Try device camera': 'Essayer la caméra de l’appareil',
        'Analyze photo': 'Analyser la photo',
        'JPEG or PNG up to 10 MB. Analyze sends a prepared copy to the model provider. Use a photo you have permission to share.':
            'JPEG ou PNG jusqu’à 10 Mo. « Analyser » envoie une copie préparée au fournisseur du modèle. Utilisez une photo que vous avez le droit de partager.',
        'Or try an example': 'Ou essayez un exemple',
        'Click a photo to analyze it live.': 'Cliquez sur une photo pour l’analyser en direct.',
        'Show simulated examples': 'Afficher des exemples simulés',
        'Use live examples': 'Utiliser les exemples en direct',
        'Simulated mode. No example photo will be sent.': 'Mode simulé. Aucune photo d’exemple ne sera envoyée.',
        'Offline preview. Sample results are simulated. No image is uploaded.':
            'Aperçu hors ligne. Les résultats d’exemple sont simulés. Aucune image n’est envoyée.',
        'Drink can': 'Canette',
        'Bare hand': 'Main nue',
        'Wood fragment': 'Morceau de bois',
        'Sample photo credits': 'Crédits des photos d’exemple',
        'Sample photo': 'Photo d’exemple',
        'Original photo preview': 'Aperçu de la photo originale',
        'Sample result · no live inference': 'Résultat d’exemple · aucune analyse en direct',
        'Cached live result · no new request': 'Résultat en direct en cache · aucune nouvelle requête',
        'Live exact-mode result': 'Résultat en direct',
        'Checking exact-mode availability…': 'Vérification de la disponibilité…',
        'Live test unavailable.': 'Test en direct non disponible.',
        'Live API unavailable. No photo was sent.': 'Service en direct non disponible. Aucune photo n’a été envoyée.',
        'The matching live kiosk API is not ready or rate-limited. No photo was sent.':
            'Le service en direct n’est pas prêt ou est limité. Aucune photo n’a été envoyée.',
        'Paste a PNG or JPEG image.': 'Collez une image PNG ou JPEG.',
        'Pasted image ready. Press Analyze photo to check it.': 'Image collée prête. Appuyez sur « Analyser la photo ».',
        'Choose a JPEG or PNG up to 10 MB.': 'Choisissez un JPEG ou un PNG de 10 Mo maximum.',
        'Choose an image under 24 megapixels.': 'Choisissez une image de moins de 24 mégapixels.',
        'Could not prepare a sufficiently small image.': 'Impossible de préparer une image assez petite.',
        'Waiting for camera permission…': 'En attente de l’autorisation de la caméra…',
        'Frame the item, then capture the photo.': 'Cadrez l’objet, puis prenez la photo.',
        'Photo captured. Check the preview before analyzing.': 'Photo prise. Vérifiez l’aperçu avant l’analyse.',
        '{message} Choose a photo instead, or use your device camera if offered.':
            '{message} Choisissez plutôt une photo, ou utilisez la caméra de votre appareil si elle est proposée.',
        'Camera permission was not granted.': 'L’accès à la caméra a été refusé.',
        'No camera was found.': 'Aucune caméra trouvée.',
        'The camera is busy or could not start.': 'La caméra est occupée ou n’a pas pu démarrer.',
        'Camera access is unavailable.': 'Accès à la caméra non disponible.',
        'This browser cannot open a camera here.': 'Ce navigateur ne peut pas ouvrir de caméra ici.',
        'Could not capture a photo.': 'Impossible de prendre une photo.',
        // Waste Wizard bins
        'Blue Bin': 'Bac bleu',
        'Green Bin': 'Bac vert',
        'Garbage Bin': 'Bac à ordures',
        'Garbage': 'Ordures',
        'HHW': 'Déchets ménagers dangereux',
        'Electronic Waste': 'Déchets électroniques',
        'Oversized Item': 'Objet surdimensionné',
        'Yard Waste': 'Résidus de jardin',
        'Metal': 'Métal',
        'Depot': 'Dépôt',
        'Christmas Tree': 'Sapin de Noël',
        'Not Accepted': 'Non accepté',
    };
    // Messages that embed a variable part produced elsewhere.
    const PATTERNS = [
        [/^Server error: (\d+)$/, code => `Erreur du serveur : ${code}`],
        [/^Capture failed: (.*)$/, rest => `Échec de la capture : ${rest}`],
        [/^Failed to process captured image: (.*)$/, rest => `Impossible de traiter la photo : ${translate(rest)}`],
    ];
    const fill = (text, vars) => vars ? text.replace(/\{(\w+)\}/g, (all, key) => Object.hasOwn(vars, key) ? String(vars[key]) : all) : text;
    function lang() {
        try { return root.localStorage?.getItem('language') === 'fr' ? 'fr' : 'en'; } catch { return 'en'; }
    }
    function translate(text) {
        if (lang() !== 'fr' || typeof text !== 'string') return text;
        if (Object.hasOwn(FR, text)) return FR[text];
        for (const [pattern, render] of PATTERNS) { const m = pattern.exec(text); if (m) return render(m[1]); }
        return text;
    }
    // t('Model confidence: {value}', {value: '96%'}) — unknown strings pass through.
    const t = (text, vars) => fill(translate(text), vars);
    // Remembers the English source so a later language switch can re-render it.
    function setText(el, text, vars) {
        if (!el) return;
        el.setAttribute('data-i18n', '');
        el.dataset.i18nEn = text;
        if (vars) el.dataset.i18nVars = JSON.stringify(vars); else delete el.dataset.i18nVars;
        el.textContent = t(text, vars);
    }
    function apply(scope = root.document) {
        for (const el of scope.querySelectorAll('[data-i18n]')) {
            if (el.dataset.i18nEn === undefined) el.dataset.i18nEn = el.textContent.trim();
            let vars; try { vars = el.dataset.i18nVars ? JSON.parse(el.dataset.i18nVars) : undefined; } catch { vars = undefined; }
            el.textContent = t(el.dataset.i18nEn, vars);
        }
    }
    function setLanguage(next) {
        try { root.localStorage?.setItem('language', next === 'fr' ? 'fr' : 'en'); } catch { /* storage optional */ }
        root.document.documentElement.lang = lang();
        apply();
    }
    root.BennyI18n = { t, setText, apply, setLanguage, lang };
})(typeof window !== 'undefined' ? window : globalThis);
