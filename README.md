# Notes de réunion (PWA iPhone)

Remplace un enregistreur type Plaud : on enregistre avec **Dictaphone**, on importe le fichier, et l'app
transcrit en français avec les intervenants (Mistral Voxtral), puis propose résumé, questions et export.
Tout est stocké sur le téléphone (IndexedDB). Paiement à l'usage avec ta clé API Mistral.

## Utilisation
1. Dictaphone → enregistrement → Partager → « Enregistrer dans Fichiers » (dossier « Réunions » par ex.).
2. App → « Importer un enregistrement » → choisir le ou les fichiers. Garder l'app ouverte pendant la transcription.
3. Onglets : Transcription (nommer les intervenants, toucher l'horodatage pour réécouter), Résumé, Questions.
4. Accueil : recherche plein texte, et « Poser une question sur tout l'historique ».
5. Réglages → Sauvegarde : export/import JSON de toutes les transcriptions.

## Coûts indicatifs
- Transcription : ~0,003 $/min (≈ 0,18 $ par heure de réunion).
- Résumé ou question : environ 1 centime avec mistral-medium (modifiable dans Réglages → Avancé).

## Hébergement
Fichiers statiques à servir en HTTPS : GitHub Pages, Cloudflare Pages ou Netlify.
Puis sur l'iPhone : Safari → l'adresse → Partager → « Sur l'écran d'accueil ».

## Si l'API refuse les appels depuis le navigateur
Déployer `worker.js` sur Cloudflare Workers (gratuit) et mettre son adresse dans Réglages → Avancé.
