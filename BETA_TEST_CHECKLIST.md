# Checklist de test beta - Azul Gestao

Objectif: tester l'ERP dans un ordre logique, car plusieurs modules dependent les uns des autres.  
Quand une section est terminee, coche les cases. Quand tu trouves un probleme, note-le dans le rapport en bas du document. 

## Regles du test

- Tester avec de vraies actions, mais sur une boutique beta.
- Ne pas corriger pendant le test sauf si le bug bloque totalement.
- Toujours noter: page, action, resultat attendu, resultat obtenu.
- Tester sur PC et mobile quand la section concerne l'affichage ou la PWA.
- Priorite:
  - P0: bloque totalement l'utilisation.
  - P1: argent, stock, licence, securite, donnees fausses.
  - P2: affichage, lenteur, mobile, confort important.
  - P3: amelioration non urgente.

## Session de test

- Date:
- Testeur:
- Appareil PC:
- Appareil mobile:
- Navigateur:
- Version / commit teste:
- Organisation beta:
- Licence utilisee:

---

# Donnees de test a utiliser

Utilise ces donnees pour tester comme un vrai client. Tu peux les copier directement dans l'ERP.
Important: garde les memes noms pendant tout le test pour que les historiques, dettes, stock et rapports soient faciles a verifier.

## Boutique beta

```txt
Nom de la boutique: Boutique Kiala Fashion
Slogan: Moda, stock e caixa num so lugar
Adresse: Rua da Missao, Luanda
Telephone boutique: +244 923 450 900
Devise: Kz
Mode de stock 1: Apenas Stock Boutique
Mode de stock 2: Stock Boutique + Armazem
```

## Licences de test

Utilise de vraies cles generees dans ton admin. Les valeurs ci-dessous sont seulement des noms de reference pour organiser le test.

```txt
Licence proprietaire: AZUL-BETA-OWNER-001
Licence mobile: AZUL-BETA-MOBILE-001
Licence suspendue: AZUL-BETA-SUSPEND-001
Licence multi-utilisateur: AZUL-BETA-TEAM-001
```

## Utilisateurs de test

Le premier utilisateur doit devenir proprietaire naturellement. Les autres doivent attendre validation dans Equipe.

| Role a tester | Nom | Email | Telephone | Mot de passe |
|---|---|---|---|---|
| Proprietaire | Ana Kiala | ana.kiala.beta@gmail.com | +244 923 450 901 | AzulBeta@2026 |
| Gerant | Paulo Mateus | paulo.mateus.beta@gmail.com | +244 923 450 902 | AzulBeta@2026 |
| Vendeur | Carla Mendes | carla.mendes.beta@gmail.com | +244 923 450 903 | AzulBeta@2026 |
| Stock | Edson Silva | edson.silva.beta@gmail.com | +244 923 450 904 | AzulBeta@2026 |
| Utilisateur suspendu | Bruno Costa | bruno.costa.beta@gmail.com | +244 923 450 905 | AzulBeta@2026 |

## Fournisseurs

| Nom fournisseur | Telephone | Pays | Note |
|---|---|---|---|
| Guangzhou Moda Import | +86 138 0000 1001 | China | Fornecedor principal roupa |
| Mercado Kikolo Atacado | +244 923 100 200 | Angola | Reforco rapido local |
| Dubai Shoes Center | +971 55 100 2000 | UAE | Calcados importados |
| Luanda Embalagens | +244 923 777 900 | Angola | Sacos, etiquetas e caixas |

## Clients

| Nom client | Telephone | Email | Situation a tester |
|---|---|---|---|
| Joao Pedro | +244 923 501 001 | joao.pedro.beta@gmail.com | Cliente normal |
| Maria Lopes | +244 923 501 002 | maria.lopes.beta@gmail.com | Cliente a credito |
| Restaurante Sol Nascente | +244 923 501 003 | compras.solnascente@gmail.com | Cliente com compras grandes |
| Cliente Anonimo | | | Venda sem nome |

## Produits pour achats et stock

| Produit | Code | Categoria | Variacao | Fornecedor | Qtd | P. compra | P. venda | Stock min |
|---|---|---|---|---|---:|---:|---:|---:|
| Tshirt Gucci Premium Preto | TSH-GUC-PRETO | Roupa | S,M,L,XL | Guangzhou Moda Import | 24 | 8500 | 15000 | 5 |
| Sapatilhas Adidas XLG Branco | SAP-ADI-XLG-BR | Calcado | 39,40,41,42,43 | Dubai Shoes Center | 15 | 18000 | 29990 | 3 |
| Calca Jeans Azul Slim | CAL-JEA-AZ-SLIM | Roupa | 32,34,36,38 | Guangzhou Moda Import | 18 | 12000 | 22000 | 4 |
| Bolsa Feminina Castanha | BOL-FEM-CAST | Acessorio | Unico | Mercado Kikolo Atacado | 10 | 9500 | 17500 | 2 |
| Perfume Oud Royal 100ml | PERF-OUD-100 | Perfume | 100ml | Dubai Shoes Center | 8 | 14500 | 28000 | 2 |
| Relogio Digital Sport | REL-DIG-SPORT | Acessorio | Preto,Azul | Mercado Kikolo Atacado | 12 | 7000 | 13500 | 3 |
| Camisa Social Branca | CAM-SOC-BR | Roupa | M,L,XL | Guangzhou Moda Import | 20 | 9000 | 16500 | 5 |
| Chinelo Praia Azul | CHI-PRA-AZ | Calcado | 40,41,42 | Mercado Kikolo Atacado | 30 | 2500 | 5000 | 8 |

## Achats a enregistrer

### Achat comptant

```txt
Data: date du jour
Fornecedor: Guangzhou Moda Import
Produto: Tshirt Gucci Premium Preto
Quantidade: 24
Preco compra: 8500
Preco venda: 15000
Pagamento: Cash total
```

### Achat a credit fournisseur

```txt
Data: date du jour
Fornecedor: Dubai Shoes Center
Produto: Sapatilhas Adidas XLG Branco
Quantidade: 15
Preco compra: 18000
Preco venda: 29990
Total: 270000 Kz
Pago agora: 100000 Kz
Reste a payer: 170000 Kz
```

### Paiement fournisseur plus tard

```txt
Fornecedor: Dubai Shoes Center
Data: date du jour + 1
Montant paye: 70000 Kz
Note: Pagamento parcial teste beta
```

## Ventes a enregistrer

### Vente interne cash

```txt
Cliente: Joao Pedro
Produto: Tshirt Gucci Premium Preto
Quantidade: 2
Preco venda: 15000
Pagamento: Cash 30000 Kz
Type: Interno
Attendu: stock diminue de 2
```

### Vente interne multi-paiement

```txt
Cliente: Restaurante Sol Nascente
Produit 1: Camisa Social Branca, Qtd 3, Prix 16500
Produit 2: Bolsa Feminina Castanha, Qtd 1, Prix 17500
Total: 67000 Kz
Cash: 30000 Kz
Express: 37000 Kz
Type: Interno
```

### Vente a credit client

```txt
Cliente: Maria Lopes
Produto: Sapatilhas Adidas XLG Branco
Quantidade: 1
Preco venda: 29990
Cash: 10000 Kz
Credito: 19990 Kz
Type: Interno
Attendu: dette client Maria Lopes = 19990 Kz
```

### Vente externe

```txt
Cliente: Cliente Anonimo
Produto: Perfume Oud Royal 100ml
Quantidade: 2
Preco venda: 28000
Type: Externo
Pagamento: Express 56000 Kz
Attendu: stock boutique ne diminue pas
```

## Depenses

| Data | Categoria | Descricao | Valor | Metodo |
|---|---|---|---:|---|
| Date du jour | Transporte | Taxi para buscar mercadoria | 3500 | Cash |
| Date du jour | Internet | Pacote mensal internet loja | 12000 | Express |
| Date du jour | Renda | Renda mensal loja | 85000 | Transferencia |
| Date du jour | Embalagem | Sacos personalizados | 15000 | Cash |
| Date du jour | Marketing | Publicidade Instagram | 20000 | Cartao |

## Revendeurs

| Nom revendeur | Telephone | Produits a confier | Condition |
|---|---|---|---|
| Neide Revendas | +244 923 600 100 | 3 Tshirt, 2 Chinelo | Paiement apres vente |
| Carlos Boutique Bairro | +244 923 600 101 | 2 Camisa, 1 Relogio | Paiement partiel |

## Tresorerie manuelle

```txt
Entree manuelle: Capital inicial, 500000 Kz
Sortie manuelle: Manutencao loja, 7500 Kz
Transfert caisse: Cash vers banco, 100000 Kz
```

## Corrections a tester

```txt
Correction vente: corriger quantite Tshirt de 2 a 1
Correction achat: corriger prix achat Sapatilhas de 18000 a 17500
Correction depense: corriger Internet de 12000 a 10000
Correction paiement client: corriger paiement Maria de 10000 a 12000
```

## Donnees pour tester les textes longs

Utilise ce produit pour verifier que les cartes ne cassent pas:

```txt
Produit: SAPATILHAS_ADIDAS_XLG_2.0_Branco_HQ7468_00_plp_standard_edicao_limitada_luanda_beta
Code: SAP-LONG-TEST-2026
Categorie: Calcado Especial Premium Importado
Variation: 39,40,41,42,43,44,45
Fornecedor: Dubai Shoes Center
Qtd: 99
Preco compra: 10000
Preco venda: 14999.99
```

---

# 1. Preparation

But: verifier que l'environnement de test est propre avant de commencer.

- [✅] Le site Vercel s'ouvre correctement.
- [✅] Le cache PWA a ete recharge apres le dernier deploiement.
- [✅] Supabase est accessible.
- [✅] Les tables principales existent.
- [✅] Les politiques RLS ne bloquent pas l'utilisation normale.
- [✅] Une licence beta neuve est disponible.
- [✅] Une boutique beta vide ou controlee est prete.
- [✅] Les roles de test sont definis: proprietaire, gerant, vendeur, stock.

Resultat attendu: l'environnement est pret, sans donnees melangees avec d'anciens tests.

---

# 2. Licence, inscription et connexion

Dependance: aucune. C'est la base avant tout le reste.

## 2.1 Premiere activation

- [✅] Ouvrir `index.html`.
- [✅] Choisir creation de compte / inscription.
- [✅] Entrer une licence neuve.
- [✅] Entrer le nom de la boutique.
- [✅] Entrer le nom du responsable.
- [✅] Entrer telephone, email et mot de passe.
- [✅] Valider l'inscription.
- [✅] Verifier que l'utilisateur arrive dans `core.html`.
- [✅] Verifier que l'organisation est creee.
- [✅] Verifier que la licence passe en `used`.
- [✅] Verifier que le premier utilisateur devient proprietaire.

Resultat attendu: le premier utilisateur entre directement dans l'ERP comme proprietaire.

## 2.2 Connexion suivante

- [❌] Se deconnecter.
- [❌] Se reconnecter avec email ou telephone + mot de passe.
- [❌] Verifier que l'ERP ouvre les donnees de la bonne boutique.
- [❌] Verifier qu'on ne retombe pas sur l'inscription.

Resultat attendu: connexion directe vers `core.html`.

## 2.3 Licence suspendue

- [✅] Suspendre une licence dans l'admin.
- [✅] Essayer de se connecter.
- [✅] Verifier que l'acces est bloque.
- [✅] Reactiver la licence.
- [ ] Verifier que les donnees sont intactes apres reactivation.

Resultat attendu: suspension bloque l'acces, reactivation restaure l'acces sans perte de donnees.

---

# 3. Equipe, roles et autorisation

Dependance: licence et proprietaire fonctionnels.

## 3.1 Nouvel utilisateur

- [✅] Depuis un autre appareil ou navigateur, creer un deuxieme utilisateur.
- [✅] Verifier qu'il arrive dans l'ecran d'attente d'autorisation.
- [✅] Verifier qu'il ne peut pas utiliser l'ERP avant validation.
- [✅] Sur le compte proprietaire, ouvrir Definicoes > Equipe.
- [✅] Verifier que le nouvel utilisateur apparait.
- [✅] Lui donner un role.
- [✅] Le mettre en statut actif.
- [✅] Reconnecter le nouvel utilisateur.

Resultat attendu: le nouvel utilisateur entre seulement apres validation du proprietaire.

## 3.2 Roles

- [✅] Tester role proprietaire: acces total.
- [✅] Tester role gerant: acces large mais sans droits proprietaire sensibles si prevu.
- [✅] Tester role vendeur: acces vente/client selon permission.
- [✅] Tester role stock: acces stock/achat selon permission.
- [✅] Tester utilisateur suspendu: acces bloque.
- [ ] Tester suppression utilisateur si disponible.

Resultat attendu: chaque role voit seulement ce qu'il doit voir.

## 3.3 Journal d'audit

- [✅] Faire une vente avec utilisateur 2.
- [✅] Faire un achat avec utilisateur 2.
- [✅] Faire une depense avec utilisateur 2.
- [✅] Verifier dans les historiques que l'auteur apparait.
- [✅] Verifier que le proprietaire voit qui a fait l'action.

Resultat attendu: chaque action importante garde le nom de l'utilisateur.

---

# 4. Parametres de base

Dependance: proprietaire connecte.

- [✅] Modifier nom de boutique.
- [✅] Modifier devise.
- [✅] Modifier theme.
- [✅] Modifier mode de stock: Boutique seule.
- [✅] Modifier mode de stock: Boutique + Armazem.
- [✅] Modifier informations du recu.
- [✅] Ajouter logo de recu si necessaire.
- [✅] Enregistrer les parametres.
- [✅] Rafraichir la page.
- [❌] Verifier que les parametres restent.

Resultat attendu: les parametres sont sauvegardes et appliques apres refresh.

---

# 5. Fournisseurs

Dependance: achat utilisera les fournisseurs.

- [✅] Creer un fournisseur manuellement.
- [✅] Modifier contact / pays / note.
- [✅] Verifier fiche fournisseur.
- [✅] Verifier historique vide au depart.
- [✅] Verifier dette fournisseur a 0 au depart.

Resultat attendu: fournisseur visible et pret pour les achats.

---

# 6. Achat et entree stock

Dependance: parametre mode de stock, fournisseur.

## 6.1 Achat simple paye comptant

- [✅] Aller dans Nova Compra.
- [✅] Choisir fournisseur.
- [✅] Ajouter produit avec nom, code, categorie, variation, photo si possible.
- [✅] Entrer quantite.
- [✅] Entrer prix d'achat.
- [✅] Entrer prix de vente.
- [✅] Enregistrer achat comptant.
- [✅] Verifier notification au proprietaire/gerant si action faite par un autre utilisateur.
- [✅] Verifier historique d'achat.
- [✅] Verifier fiche fournisseur.
- [✅] Verifier stock du produit.

Resultat attendu: achat enregistre, produit cree ou mis a jour, stock augmente selon mode choisi.

## 6.2 Achat a credit

- [✅] Faire un achat avec paiement partiel.
- [✅] Verifier total achat.
- [✅] Verifier montant paye.
- [✅] Verifier reste a payer.
- [✅] Verifier dette fournisseur.
- [✅] Enregistrer paiement fournisseur.
- [✅] Verifier dette apres paiement.

Resultat attendu: la dette fournisseur est correcte et diminue apres paiement.

## 6.3 Variations et images

- [✅] Ajouter plusieurs variations.
- [✅] Verifier affichage dans achat.
- [✅] Verifier affichage dans vente.
- [❌] Verifier affichage dans stock.
- [✅] Tester produit sans image.

Resultat attendu: variation et image restent visibles; sans image, affichage propre.

---

# 7. Stock

Dependance: produits crees par achat.

## 7.1 Affichage stock

- [✅] Ouvrir Estoque.
- [✅] Verifier stock total.
- [✅] Verifier stock boutique.
- [✅] Verifier stock armazem.
- [✅] Verifier valeur du stock.
- [✅] Chercher un produit avec la barre de recherche.
- [✅] Effacer recherche.
- [✅] Rafraichir / revenir dans l'onglet stock.

Resultat attendu: les chiffres sont corrects et se mettent a jour.

## 7.2 Transfert

- [✅] Si mode Boutique + Armazem: transferer un produit de l'armazem vers boutique.
- [✅] Verifier stock armazem diminue.
- [✅] Verifier stock boutique augmente.
- [✅] Transferer tout si fonction disponible.
- [✅] Verifier historique / impact stock.

Resultat attendu: transfert correct sans stock negatif.

## 7.3 Alertes stock

- [✅] Mettre un produit stock faible.
- [✅] Mettre un produit stock fini.
- [✅] Verifier dashboard principal.
- [✅] Verifier Stock intelligent.

Resultat attendu: alertes stock visibles et coherentes.

---

# 8. Clients

Dependance: ventes vont creer historique client.

- [✅] Creer une vente avec client nomme.
- [✅] Aller dans Clientes.
- [✅] Chercher le client.
- [✅] Verifier total achats.
- [✅] Verifier nombre de transactions.
- [✅] Verifier dette si vente a credit.
- [✅] Enregistrer paiement client.
- [✅] Verifier dette apres paiement.

Resultat attendu: fiche client claire, historique correct, dette correcte.

---

# 9. Vente

Dependance: stock + client.

## 9.1 Vente interne

- [✅] Aller dans Nova Venda.
- [✅] Chercher produit.
- [✅] Ajouter produit au panier.
- [✅] Modifier quantite.
- [✅] Modifier prix si necessaire.
- [✅] Confirmer paiement cash.
- [✅] Verifier historique vente.
- [✅] Verifier stock diminue.
- [✅] Verifier dashboard.
- [✅] Verifier tresorerie.
- [✅] Verifier comptabilite.

Resultat attendu: vente interne diminue le stock et augmente caisse/recette.

## 9.2 Vente externe

- [✅] Ajouter produit au panier meme si stock insuffisant.
- [✅] Choisir type externe.
- [✅] Confirmer vente.
- [✅] Verifier que le stock ne diminue pas.
- [✅] Verifier que le fournisseur/cout externe est traite selon logique prevue.
- [✅] Verifier benefice.

Resultat attendu: vente externe ne touche pas le stock boutique.

## 9.3 Multi-paiement

- [✅] Faire une vente avec cash + express.
- [✅] Faire une vente avec cash + cartao.
- [✅] Faire une vente avec une partie credito.
- [✅] Verifier total paiement = total vente.
- [✅] Verifier dette client si credito.

Resultat attendu: paiement accepte seulement si total correct, credit cree dette client.

## 9.4 Produit fini

- [✅] Mettre un produit stock 0.
- [✅] Verifier qu'on peut l'ajouter si vente externe.
- [✅] Verifier blocage ou alerte si vente interne.

Resultat attendu: comportement correct selon interne/externe.

---

# 10. Depenses

Dependance: tresorerie/dashboard.

- [✅] Enregistrer nouvelle depense.
- [✅] Choisir categorie.
- [✅] Entrer montant.
- [✅] Verifier historique depenses.
- [✅] Verifier dashboard depenses.
- [✅] Verifier dashboard principal.
- [✅] Verifier tresorerie.
- [✅] Verifier comptabilite.

Resultat attendu: depense visible partout et diminue resultat/caisse selon logique.

---

# 11. Tresorerie

Dependance: ventes, achats, depenses, paiements.

- [✅] Verifier solde global.
- [✅] Verifier entrees ventes.
- [✅] Verifier sorties depenses.
- [✅] Verifier paiements fournisseurs.
- [✅] Verifier paiements clients.
- [✅] Tester filtre date rapide.
- [✅] Tester date debut/date fin personnalisee.
- [✅] Tester affichage mobile.

Resultat attendu: tresorerie correspond aux mouvements reels.

---

# 12. Comptabilite

Dependance: ventes, achats, depenses, paiements.

- [✅] Ouvrir Demonstracao de resultados.
- [✅] Verifier recettes.
- [✅] Verifier couts.
- [✅] Verifier depenses.
- [✅] Verifier benefice.
- [✅] Ouvrir Balanco simplificado.
- [✅] Verifier dettes clients.
- [✅] Verifier dettes fournisseurs.
- [✅] Ouvrir Diario contabilistico.
- [✅] Verifier debit = credit.
- [✅] Tester filtre date.
- [✅] Tester affichage mobile.

Resultat attendu: comptabilite equilibree et coherente avec les modules.

---

# 13. Revendeurs

Dependance: stock et ventes.

- [✅] Creer revendeur.
- [✅] Ajouter produits en consignation.
- [❌] Verifier stock reserve/diminue selon logique.
- [❌] Enregistrer paiement revendeur.
- [❌] Enregistrer retour si disponible.
- [❌] Verifier historique revendeur.
- [❌] Verifier responsive mobile.

Resultat attendu: consignation claire, paiement/retour traçables.

---

# 14. Corrections

Dependance: actions deja creees.

- [✅] Corriger une vente.
- [✅] Corriger un achat.
- [✅] Corriger une depense.
- [✅] Corriger un paiement.
- [✅] Verifier stock apres correction.
- [✅] Verifier tresorerie apres correction.
- [✅] Verifier comptabilite apres correction.
- [✅] Verifier journal d'audit.

Resultat attendu: correction ne casse pas les historiques et garde une trace.

---

# 15. Imports

Dependance: base deja stable.

## 15.1 Import achats

- [✅] Telecharger modele CSV achat.
- [✅] Remplir 5 lignes.
- [✅] Importer.
- [✅] Verifier preview.
- [✅] Verifier produits crees.
- [✅] Verifier fournisseurs crees.
- [✅] Verifier stock.
- [✅] Tester doublon achat.
- [✅] Tester 100 lignes.

Resultat attendu: import rapide, sans doublons dangereux.

## 15.2 Import ventes

- [✅] Telecharger modele CSV vente.
- [✅] Importer ventes cash.
- [✅] Importer ventes multi-paiement.
- [✅] Importer ventes credit.
- [✅] Verifier produits inexistants.
- [✅] Verifier clients crees.
- [✅] Verifier stock.
- [✅] Verifier dettes.
- [✅] Tester doublon vente.

Resultat attendu: ventes importees correctement et stock/dettes coherents.

## 15.3 Import depenses

- [✅] Importer depenses simples.
- [✅] Tester categories.
- [✅] Tester doublons.
- [✅] Verifier dashboard.
- [✅] Verifier tresorerie.
- [✅] Verifier comptabilite.

Resultat attendu: depenses importees sans fausser les totaux.

---

# 16. Dashboard principal

Dependance: donnees deja creees.

- [✅] Verifier KPI ventes.
- [✅] Verifier KPI benefice.
- [✅] Verifier KPI depenses.
- [✅] Verifier alertes stock.
- [❌] Verifier tresorerie rapide.
- [✅] Verifier dettes.
- [ ] Verifier achats.
- [✅] Verifier performance commerciale.
- [✅] Verifier resume fiscal/comptable.
- [✅] Tester filtres date.
- [✅] Tester responsive mobile.

Resultat attendu: dashboard resume correctement toute la boutique.

---

# 17. Notifications

Dependance: equipe, actions utilisateur, PWA.

## 17.1 Notifications internes

- [✅] Proprietaire connecte sur PC.
- [✅] Utilisateur 2 fait une vente.
- [✅] Verifier notification interne instantanee.
- [✅] Utilisateur 2 fait un achat.
- [✅] Verifier notification interne.
- [✅] Utilisateur 2 fait une depense.
- [✅] Verifier notification interne.
- [✅] Marquer notifications lues.
- [✅] Verifier badge a 0.

Resultat attendu: proprietaire/gerant reçoivent les notifications des autres utilisateurs.

## 17.2 Notifications PWA

- [✅] Installer la PWA sur mobile.
- [✅] Cliquer `Ativar PWA`.
- [✅] Accepter permission notification.
- [✅] Fermer l'application.
- [✅] Depuis autre utilisateur, faire une vente.
- [✅] Verifier notification mobile app fermee.
- [✅] Cliquer notification.
- [✅] Verifier ouverture de l'ERP.

Resultat attendu: notification reçue meme app fermee.

Note mobile: sur iPhone, cela marche seulement si l'app est installee comme PWA sur l'ecran d'accueil.

---

# 18. Offline / PWA

Dependance: PWA installee.

- [✅] Ouvrir l'app en ligne.
- [✅] Couper internet.
- [✅] Verifier que l'app ne deconnecte pas brutalement.
- [✅] Verifier pages deja chargees.
- [✅] Reconnecter internet.
- [✅] Verifier synchronisation normale.
- [✅] Tester refresh.

Resultat attendu: l'app reste utilisable au minimum en consultation, sans perte de session.

---

# 19. Responsive mobile global

Dependance: modules principaux deja testes.

- [✅] Login mobile.
- [✅] Dashboard mobile.
- [✅] Vente mobile.
- [✅] Panier mobile.
- [✅] Achat mobile.
- [✅] Stock mobile.
- [✅] Clients mobile.
- [✅] Depenses mobile.
- [✅] Tresorerie mobile.
- [✅] Comptabilite mobile.
- [✅] Revendeurs mobile.
- [✅] Parametres mobile.
- [✅] Verifier qu'aucun texte long ne casse les cartes.
- [✅] Verifier que le menu hamburger ne cache pas les barres fixes.

Resultat attendu: app confortable sur smartphone.

---

# 20. Securite et limites

- [✅] Acces core.html sans session.
- [✅] Acces admin sans droit admin.
- [✅] Licence inactive.
- [✅] Utilisateur suspendu.
- [✅] Limite appareils.
- [✅] Limite utilisateurs.
- [✅] RLS Supabase avec produits.
- [✅] RLS Supabase avec ventes.
- [✅] RLS Supabase avec achats.
- [✅] RLS Supabase avec depenses.

Resultat attendu: aucun acces non autorise.

---

# Rapport de bug

Voici le rapport des problemes de ce test :
1.Tout les module revendeur ne marche pas 
2.En mobile bloque les boutons pour eviter dentre les meme donne deux fois et aussi ajoute un chargement 
3.Le paiement de fournisseur ne doit passer le montant de la dette
4.Dans les historiques met les donnees les plus recent en haut
5.Les variations produit napparait null part dans lhistorique stock
6.Le vendeur voit la tresorerie pourquoi ?
7.Les parametres des recus ne sont pas appliquer
8.Dans la fiche client le nombre de trasaction est inaxacte
9.Dans la fiche de client lhistorique de paiement de ses dettes doit apparai

---

# Rapport de fin de session

```txt
Date:
Temps de test:
Modules testes:
Nombre de bugs P0:
Nombre de bugs P1:
Nombre de bugs P2:
Nombre de bugs P3:

Ce qui fonctionne bien:

Ce qui bloque la beta:

Ce qui peut attendre:

Decision:
[✅] Continuer les corrections
[ ] Pret pour beta limitee
[ ] Pret pour beta publique
```
