# Azul - Matrice technique de preparation AGT

**Statut :** document de travail technique. Il ne vaut ni validation ni certification par l'AGT.

## Objectif

Faire d'Azul un programme de facturation dont les documents, les corrections et les archives peuvent etre controles par l'AGT. Cette matrice se base sur le Regime Juridique des Facturas et Documents Equivalents cite par l'AGT, notamment le guide fiscal publie par l'administration.

## Sources a conserver dans le dossier de validation

- Guide du Systeme Tributario Angolais, section « Regime Juridico das Facturas ».
- Decret Presidentiel n. 149/13, 1 octobre 2013.
- Exigences techniques, scenarios de test et formats SMF remis directement par l'AGT.

Les specifications detaillees du SMF ne sont pas disponibles publiquement sans authentification. Elles doivent etre jointes a ce document des que l'AGT les communique.

## Matrice de conformite

| Exigence | Etat actuel dans Azul | Travail avant soumission | Priorite |
| --- | --- | --- | --- |
| Raison sociale, NIF et adresse de l'emetteur | Partiel : profil fiscal existant | Rendre ces champs obligatoires pour tout document fiscal | P0 |
| Identification du client et NIF | Partiel : client facultatif dans la vente | Regles explicites par type de document et seuil AGT | P0 |
| Numero sequentiel et chronologique | Implemente dans le noyau fiscal | Format final a confirmer avec l'AGT | P0 |
| Impossibilite de modifier une facture emise | Implemente dans le noyau fiscal | Tests de non-regression et validation AGT | P0 |
| Annulation tracee | Note de credit liee implementee | Ajouter note de debit et parcours complet de correction | P0 |
| Produits/services, quantites, prix final et impots | Partiel : lignes de vente et total | Instantane fiscal des lignes, taux, base, TVA et remises | P0 |
| Date d'operation et date d'emission | Partiel | Enregistrer les deux dates, fuseau Angola et horodatage non modifiable | P0 |
| Facture, facture-recibo, recibo, proforma, note de credit/debit | Partiel : recu et proforma | Modeles, numeros et effets comptables separes pour chaque type | P0 |
| Mention « processado por computador » | A verifier | Ajouter aux impressions fiscales si la regle AGT applicable le requiert | P1 |
| Journal d'audit | Partiel : corrections et historique applicatif | Journal append-only pour creation, impression, annulation, export, changement de serie | P0 |
| Conservation et consultation 5 ans | Non formalise | Archivage, export par periode, retention et test de restauration | P0 |
| Export de controle | Preparation SAF-T par periode, avec historique et erreurs | Generer et valider le XML final avec le XSD AGT | P0 bloque par XSD AGT |
| Sauvegarde et restauration | Backup existant mais a verifier | Backup chiffre, restauration testee et preuve de controle d'integrite | P1 |
| Identification de la version Azul | Partiel | Version de build dans chaque document/export et registre des versions | P1 |
| Acces par role | Existant | Interdire l'annulation et les reglages fiscaux aux roles non autorises | P1 |
| Integration SMF | Non commencee | Attendre la specification et les identifiants techniques AGT | P0 bloque par AGT |

## Regles de conception non negociables

1. Une facture emise est une ecriture fiscale definitive. Elle ne peut pas etre supprimee ni editee.
2. Toute correction produit un nouveau document lie a l'original ; elle ne remplace jamais l'historique.
3. Chaque numero fiscal est unique dans sa serie et aucune rupture n'est silencieusement ignoree.
4. Le rendu PDF/imprime est genere a partir d'un instantane fiscal enregistre, jamais a partir des donnees produit actuelles.
5. Le serveur calcule les montants et verifie les droits. Le navigateur ne constitue pas une source de verite fiscale.
6. Chaque export est reproductible, date, signe par son contenu et trace dans le journal d'audit.

## Documents disponibles dans Azul

| Document | Usage dans Azul | Effet sur stock / comptabilite | Regle de protection |
| --- | --- | --- | --- |
| Factura (FT) | Vente facturee, a payer ou deja payee selon le moyen de paiement | La vente source conserve ses effets | Document fiscal immuable |
| Factura-recibo (FR) | Vente facturee et reglee immediatement | La vente source conserve ses effets | Document fiscal immuable |
| Recibo (RC) | Preuve de reception du paiement d'une facture | Ne cree pas une nouvelle vente | Lie a la facture originale |
| Proforma (PP) | Proposition commerciale avant acceptation | Aucun effet | Marquee explicitement « NAO E DOCUMENTO FISCAL » |
| Nota de credito (NC) | Correction ou annulation motivee d'une facture | Effet comptable a completer dans le parcours de correction | Liee au document original |
| Nota de debito (ND) | Ajustement augmente par une nouvelle dette justifiee | A finaliser avec les regles AGT | Liee au document original |

Les series FT, FR, RC, PP, NC et ND sont des conventions Azul provisoires. Leur libelle et leur format final seront ajustes selon la specification SMF/AGT recue lors de la validation.

Chaque document emis apres la migration de format fige aussi la devise AOA, la base taxable, le taux et montant de TVA lorsque le document est fiscal, le statut de paiement et le lieu d'emission. Les anciens documents ne sont pas modifies retrospectivement afin de conserver une piste d'audit coherente.

## Plan de livraison technique

### Lot 1 - Noyau fiscal inviolable (implemente sur `develop`, a migrer)

- Tables `fiscal_document_series`, `fiscal_documents`, `fiscal_document_events`.
- Fonction transactionnelle serveur pour emettre une facture et reserver son numero. Les lignes, emetteur, client et totaux sont figees dans un instantane JSONB avec le document.
- Politique RLS : ecriture uniquement via fonctions controlees ; lecture selon le role et l'organisation.
- Fonction securisee de note de credit, rattachee a la facture d'origine avec motif obligatoire.
- Module `Documentos fiscais` pour rechercher, consulter, imprimer et corriger les documents sans toucher aux donnees figees.
- Les roles lecture consultent le registre ; seuls proprietaire, gerant et comptable peuvent emettre ou corriger au niveau de la base.
- Migration des ventes existantes sans modifier leur historique.

### Lot 2 - Corrections reglementees

- Notes de credit et de debit.
- Annulation motivee, auteur identifie, reference du document original.
- Ecran de consultation de la chaine documentaire.

### Lot 3 - Archivage et controles

- Preparation SAF-T de facturation par periode, avec historique des controles et erreurs exploitables dans le module `SAF-T`.
- Export XML technique de facturation et d'inventaire par une Edge Function protegee, telechargeable seulement apres controle et trace dans l'historique.
- Signature RSA SHA-1/Base64 de la chaine documentaire par serie, realisee uniquement dans l'Edge Function avec une cle privee hors base et hors navigateur. La cle et sa version sont gardees dans les secrets Supabase.
- Donnees maitre SAF-T sur les produits : type et code de taxe, avec controle des codes et unites manquants.
- Rapport des numeros manquants, documents annules, corrections et ecritures sans NIF.
- Sauvegarde/restauration testee et tracee.

### Limite explicite avant homologation

Le module `SAF-T` actuellement livre ne cree pas encore de fichier XML officiel et ne marque aucun fichier comme soumis a l'AGT. Il reste en mode preparation tant que les elements suivants ne sont pas recus et testes :

1. Le XSD/format SAF-T officiel applicable au logiciel de facturation et, si necessaire, au SAF-T comptable.
2. Les regles de signature, de hachage et de numerotation confirmees pour la version d'Azul soumise.
3. Les identifiants, certificats ou environnement de test SMF/AGT.
4. Les scenarios de recette et la validation ecrite de l'AGT.

La generation XML est executee cote serveur, avec les secrets dans l'Edge Function et jamais dans le navigateur ni dans la base applicative. Tant que le XSD et le numero de validation AGT ne sont pas renseignes, tout XML porte le statut technique et ne doit pas etre soumis.

### Mise en service securisee de la signature

1. Generer la paire RSA du fabricant dans un poste controle, puis conserver le fichier prive hors Git et hors des postes clients.
2. Convertir la cle privee au format PKCS#8 Base64 pour le secret `AZUL_SAFT_RSA_PRIVATE_KEY_PKCS8_BASE64` de l'Edge Function.
3. Configurer `AZUL_ALLOWED_ORIGINS`, `AZUL_SAFT_KEY_VERSION`, la version produit et, apres validation, `AZUL_SAFT_SOFTWARE_VALIDATION_NUMBER` dans les secrets Supabase.
4. Deployer la fonction `saft-export`, executer les controles et verifier la signature avec la cle publique avant toute livraison AGT.
5. Fournir la cle publique/certificat a l'AGT selon la procedure applicable, puis seulement ensuite retirer la mention technique de l'export.

Exemple de creation locale de la paire (a executer uniquement sur un poste du fabricant protege) :

```bash
openssl genrsa -out azul-saft-private.pem 1024
openssl pkcs8 -topk8 -nocrypt -in azul-saft-private.pem -out azul-saft-private-pkcs8.pem
openssl base64 -A -in azul-saft-private-pkcs8.pem -out azul-saft-private-pkcs8.base64
openssl rsa -in azul-saft-private.pem -pubout -out azul-saft-public.pem
```

Le contenu de `azul-saft-private-pkcs8.base64` est place une seule fois dans le secret Supabase. Les fichiers prives sont ensuite retires du poste de developpement et conserves dans le coffre-fort du fabricant ; seule la cle publique peut etre transmise a l'AGT.

Le fichier [`.env.example`](../supabase/functions/.env.example) liste uniquement les noms des secrets : aucune cle privee ne doit etre envoyee dans GitHub, Vercel ou le navigateur.

### Lot 4 - Adaptateur SMF/AGT

- Implementation uniquement apres reception de la specification officielle.
- Tests de conformite fournis par l'AGT.
- Gel de la version candidate et dossier technique correspondant.

## Scenarios de test obligatoires

1. Vente comptant avec TVA.
2. Vente a credit puis paiement partiel/complet.
3. Vente avec remise.
4. Facture avec client et NIF.
5. Facture annulee par note de credit.
6. Reimpression sans changement du contenu fiscal.
7. Tentative de modification ou suppression apres emission.
8. Deux ventes simultanees : numeros consecutifs et uniques.
9. Export d'un mois puis rapprochement avec les factures emises.
10. Restauration d'une sauvegarde et verification des numeros et journaux.

## Informations a obtenir de l'AGT

- Procedure et formulaire de validation d'un programme de facturation.
- Specification SMF applicable aux programmes SaaS.
- Format obligatoire d'export/declaration et environnement de test.
- Regles de certification/versionnement et traitement des mises a jour.
- Cas d'usage obligatoires : communication en ligne, fonctionnement hors ligne, signature, QR code, imprimantes et copies.
