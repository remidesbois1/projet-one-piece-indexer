# Rapport — intérêt de la confiance LightOnOCR-2 dans Poneglyph

_Généré le 2026-07-28T17:05:54.476039+00:00._

## Verdict

Le signal est suffisamment discriminant pour justifier un prototype de priorisation de revue, sous réserve d'une calibration séparée.

Sur **1128 bulles**, le modèle commet une erreur sur **80** bulles (7.09 %), avec un CER corpus de **0.397 %**. Le signal opérationnel recommandé est `min_confidence` : ROC-AUC **0.867**, AP **0.425** pour une prévalence d'erreur de **0.071**.

## Protocole et provenance

Les IDs proviennent du benchmark test public figé, puis chaque ground truth et chaque crop sont réexportés depuis `bulles`/`pages` dans Supabase avec `statut = Validé`. Le modèle est évalué en greedy decoding avec le même prompt, la même résolution dynamique (700 px) et le même post-traitement première ligne que le benchmark de fine-tune.

- Révision modèle : `43075526e81640bf2b18ec8f35a45f7dfb1ddfec`
- Ground truths exportés : 1128
- Ground truths modifiés depuis le benchmark publié : 3
- Tokens analysés : 11795
- Mots analysés : 7329

Le split test est tenu à l'écart de l'entraînement par le pipeline de fine-tune. En revanche, la sélection du meilleur agrégat et des seuils est faite sur ce même benchmark exploratoire : leurs valeurs sont donc descriptives et devront être confirmées sur un futur lot de corrections.

## Qualité OCR observée

| Mesure | Valeur |
| --- | --- |
| Bulles | 1128 |
| Erreurs bulle | 80 |
| Erreurs alphanumériques substantielles | 25 |
| Écarts casse / ponctuation uniquement | 55 |
| Exact match | 92.91 % |
| CER corpus | 0.3974 % |
| Éditions Levenshtein | 150 |
| Temps moyen / bulle | 0.045 s |
| Pic mémoire CUDA max | 3.57 Gio |

## Coût de récupération des scores

Profil A/B sur **128 crops**, batch **16**, avec **3 répétitions** et ordre alterné :

| Mesure | Sans scores | Avec scores choisis | Surcoût |
| --- | --- | --- | --- |
| Temps médian | 5.994 s | 6.179 s | +3.10 % |
| Débit | 21.36 bulles/s | 20.71 bulles/s | — |
| Pic VRAM | 2.14 Gio | 3.57 Gio | +1460.2 Mio |

Les séquences sont identiques dans **128 / 128** comparaisons (mismatch : 0). Ce profil couvre `output_scores=True` et `compute_transition_scores`, sans calcul des alternatives top-k, puisque celles-ci n'améliorent pas le signal recommandé.

## Corrélation au niveau bulle

| Signal | ROC-AUC | AP | Spearman erreur | Spearman CER |
| --- | --- | --- | --- | --- |
| min_margin | 0.867 | 0.423 | 0.327 | 0.327 |
| min_confidence | 0.867 | 0.425 | 0.327 | 0.327 |
| geometric_mean_confidence | 0.858 | 0.416 | 0.319 | 0.320 |
| mean_negative_log_likelihood | 0.858 | 0.416 | 0.319 | 0.320 |
| mean_margin | 0.858 | 0.403 | 0.318 | 0.320 |
| mean_confidence | 0.858 | 0.408 | 0.318 | 0.320 |
| p10_confidence | 0.813 | 0.377 | 0.278 | 0.282 |
| low_confidence_count_090 | 0.740 | 0.330 | 0.407 | 0.409 |
| low_confidence_count_080 | 0.700 | 0.308 | 0.398 | 0.400 |
| low_confidence_count_050 | 0.536 | 0.119 | 0.208 | 0.218 |

`min_margin` obtient la meilleure AUC brute, mais son écart avec `min_confidence` n'est que de **0.000066** point d'AUC et son AP est légèrement inférieure. La recommandation est donc `min_confidence`, plus simple et ne nécessitant pas le top-2.

ROC-AUC mesure l'ordre relatif entre bulles correctes et erronées. L'average precision (AP) est plus sévère ici car les erreurs sont rares. Une AP proche de la prévalence correspond à un tri peu utile.

Intervalle bootstrap par page pour `min_confidence` : ROC-AUC 95 % **[0.8249604569785224, 0.9053693548777169]**, AP 95 % **[0.314197892346457, 0.5474513234910597]**. Le bootstrap se fait par page, et non par bulle, pour conserver la corrélation entre bulles issues d'une même page.

En retirant les écarts limités à la casse/ponctuation, il reste **25 erreurs substantielles**. Le même signal donne ROC-AUC **0.915** et AP **0.366**. À 20 % de revue, il en capture **84.0 %**.

## Valeur opérationnelle : budget de revue

| Bulles relues | Nombre | Erreurs trouvées | Rappel erreurs | Précision revue | Gain vs hasard |
| --- | --- | --- | --- | --- | --- |
| 5 % | 57 | 30 | 37.5 % | 52.6 % | ×7.50 |
| 10 % | 113 | 42 | 52.5 % | 37.2 % | ×5.25 |
| 20 % | 226 | 57 | 71.2 % | 25.2 % | ×3.56 |
| 30 % | 339 | 64 | 80.0 % | 18.9 % | ×2.67 |
| 50 % | 564 | 76 | 95.0 % | 13.5 % | ×1.90 |

Ces valeurs répondent à la question produit la plus concrète : combien d'erreurs retrouve-t-on si l'interface ne demande de vérifier qu'une fraction des bulles ? Elles sont plus directement actionnables qu'un coefficient de corrélation seul.

## Niveau token et localisation

Parmi **11795 tokens émis**, **86** chevauchent une substitution ou une suppression dans l'alignement Levenshtein. La probabilité du token donne ROC-AUC **0.930** et AP **0.295** pour les localiser.

Calibration brute token : confiance moyenne **0.9955**, exactitude empirique **0.9927**, ECE **0.0035**, Brier **0.00595**.

Attention : **11651 / 11795** tokens sont dans la tranche 0,9–1,0. Le faible ECE global est donc largement dominé par cette masse de tokens faciles ; il ne suffit pas à valider un seuil dans la zone basse, où les effectifs sont petits.

**25 rattachements d'omission** ont été observés. Ils ne sont pas comptés comme erreurs token strictes : une lettre absente de la sortie n'a pas de logit choisi. Pour ces cas, seules la confiance globale, la relecture du mot voisin, le désaccord entre moteurs ou une seconde passe peuvent apporter un signal.

## Seuils exploratoires

Seuils du signal recommandé, ajustés sur ce jeu (donc non encore généralisables) :

```json
{
  "0.80": {
    "confidence_at_or_below": 0.9947032454792522,
    "review_count": 315,
    "review_fraction": 0.27925531914893614,
    "error_recall": 0.8,
    "review_precision": 0.20317460317460317
  },
  "0.90": {
    "confidence_at_or_below": 0.997805652820595,
    "review_count": 411,
    "review_fraction": 0.36436170212765956,
    "error_recall": 0.9,
    "review_precision": 0.17518248175182483
  },
  "0.95": {
    "confidence_at_or_below": 0.9994382439611917,
    "review_count": 563,
    "review_fraction": 0.499113475177305,
    "error_recall": 0.95,
    "review_precision": 0.1349911190053286
  }
}
```

## Exemples d'erreurs prioritaires

| ID | CER | min_confidence | Référence | Prédiction |
| --- | --- | --- | --- | --- |
| 1842 | 0.057 | 0.3005 | Avec à son bord "Zoro le chasseur de pirates", premier membre de son équipage, le bateau v | Avec à son bord "Zoro le chasseur de pirates", premier membre de son équipage, le bateau v |
| 526 | 0.643 | 0.3098 | Oouuuiiinnn !! | Oooooo !! |
| 8041 | 0.133 | 0.3994 | Et moi Yosaku ! | Et moi, yosaku ! |
| 2834 | 0.068 | 0.3994 | "Arrête de te moquer, c'est par pitié que je te fais cette proposition !" | "Arrête de te moquer, c'est parfois que je te fais cette proposition !" |
| 8540 | 1.400 | 0.4490 | Aahhh | Riitter |
| 2833 | 0.054 | 0.4999 | « Ha, ha, ha, elle est bonne celle-là, monsieur le maire ! Depuis quand aimez-vous la nour | "Ha, ha, ha, elle est bonne celle-là, monsieur le maire ! Devis quand aimez-vous la nourri |
| 7017 | 0.014 | 0.5077 | Au fait, comment se faisait-il appeler dans le village ? Kla... Klaha... | Au fait, comment se faisait-il appeler dans le village ? Kla... Klah... |
| 6202 | 0.286 | 0.5109 | Pschiii | Pochii |
| 7609 | 0.222 | 0.5171 | Cui cui ! | Cui, oui ! |
| 5138 | 0.129 | 0.5296 | “N'ayez pas peur mademoiselle ! | "N'avez pas deur mademoiselle !" |
| 414 | 0.062 | 0.5302 | T'as... T'as osé tirer, salaud ! | T'as... t'as osé tirer, Salaud ! |
| 6508 | 0.045 | 0.5312 | Pff... Les imbéciles ! | Pff... les imbéciles ! |

## Faux négatifs : erreurs très confiantes

Ces cas sont la raison pour laquelle la confiance ne doit jamais auto-valider seule une transcription :

| ID | Catégorie | CER | min_confidence | Référence | Prédiction |
| --- | --- | --- | --- | --- | --- |
| 1789 | typography_case_only | 0.017 | 0.999988 | Maintenant, vous allez quitter cette ville sur-le-champ !! | Maintenant vous allez quitter cette ville sur-le-champ !! |
| 2387 | typography_case_only | 0.273 | 0.999955 | Non, ça va… | Non, ça va... |
| 4625 | typography_case_only | 0.040 | 0.999922 | Vous voulez voir usopp ?! | Vous voulez voir Usopp ?! |
| 5294 | typography_case_only | 0.029 | 0.999654 | Que se passe-t-il, mademoiselle ?! | Que se passe-t-il mademoiselle ?! |
| 2537 | typography_case_only | 0.048 | 0.999438 | Où sont-ils passés ?! | Où sont-ils passés ?!! |
| 7936 | typography_case_only | 0.071 | 0.999192 | Un... Un seul. | Un... un seul. |
| 544 | typography_case_only | 0.062 | 0.998690 | Et devenir le Roi des Pirates !! | Et devenir le roi des pirates !! |
| 5733 | substantive | 0.043 | 0.998042 | Ne t'en fais pas, ce n'est pas ce qui le tuera. | Ne t'en fais pas, ce n'est pas ça qui le tuera. |
| 1837 | typography_case_only | 0.014 | 0.997806 | Pour la peine, vous serez tous privés de repas pendant une semaine !! | Pour la peine vous serez tous privés de repas pendant une semaine !! |
| 97 | typography_case_only | 0.029 | 0.997193 | un navire pirate y a jeté l'ancre. | Un navire pirate y a jeté l'ancre. |

## Recommandation d'implémentation

Si le verdict est positif ou modéré, l'intégration conseillée est optionnelle : conserver les log-probabilités des tokens choisis, agréger au minimum par mot et par bulle, puis calibrer un score de revue propre à LightOnOCR. Il ne faut pas exposer directement la probabilité softmax comme « probabilité que le texte soit juste ».

Première version recommandée :

1. score bulle fondé sur `min(token_probability)`, calibré sur un lot séparé ;
2. surlignage mot avec `min(token_probability)` et moyenne géométrique ;
3. raison explicite `low_local_confidence` plutôt qu'un verdict silencieux ;
4. budget de revue configurable, au lieu d'un seuil universel fixe ;
5. journalisation des confirmations/corrections pour recalibrer ;
6. ajout ultérieur du désaccord inter-modèles pour couvrir les erreurs confiantes et omissions.

## Limites

- Un modèle peut être très confiant et faux : l'AUC mesure ce risque mais ne l'annule pas.
- Le tokeniseur ne suit pas les frontières de mots ; le surlignage UI doit agréger les sous-tokens.
- Les alternatives top-k sont locales au prochain token, pas des alternatives fiables au mot complet.
- Les seuils sont sélectionnés sur le jeu analysé et doivent être validés hors échantillon.
- Les corrections Supabase postérieures à la publication modifient légèrement la comparaison historique.
- `output_scores=True` conserve les logits de chaque pas ; l'expérience utilise des batchs de 16 et a mesuré le pic VRAM.

## Figures et données

- `lighton_confidence_sample_level.png` : discrimination et rendement de revue ;
- `lighton_confidence_token_level.png` : distributions, calibration et marges ;
- `predictions.jsonl` : probabilités et top-k bruts ;
- `sample_records.csv`, `token_records.csv`, `word_records.csv` : tables d'analyse ;
- `metrics.json` : toutes les métriques et intervalles.
