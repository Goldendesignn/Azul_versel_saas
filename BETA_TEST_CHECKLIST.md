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

# 1. Preparation

But: verifier que l'environnement de test est propre avant de commencer.

- [ ] Le site Vercel s'ouvre correctement.
- [ ] Le cache PWA a ete recharge apres le dernier deploiement.
- [ ] Supabase est accessible.
- [ ] Les tables principales existent.
- [ ] Les politiques RLS ne bloquent pas l'utilisation normale.
- [ ] Une licence beta neuve est disponible.
- [ ] Une boutique beta vide ou controlee est prete.
- [ ] Les roles de test sont definis: proprietaire, gerant, vendeur, stock.

Resultat attendu: l'environnement est pret, sans donnees melangees avec d'anciens tests.

---

# 2. Licence, inscription et connexion

Dependance: aucune. C'est la base avant tout le reste.

## 2.1 Premiere activation

- [ ] Ouvrir `index.html`.
- [ ] Choisir creation de compte / inscription.
- [ ] Entrer une licence neuve.
- [ ] Entrer le nom de la boutique.
- [ ] Entrer le nom du responsable.
- [ ] Entrer telephone, email et mot de passe.
- [ ] Valider l'inscription.
- [ ] Verifier que l'utilisateur arrive dans `core.html`.
- [ ] Verifier que l'organisation est creee.
- [ ] Verifier que la licence passe en `used`.
- [ ] Verifier que le premier utilisateur devient proprietaire.

Resultat attendu: le premier utilisateur entre directement dans l'ERP comme proprietaire.

## 2.2 Connexion suivante

- [ ] Se deconnecter.
- [ ] Se reconnecter avec email ou telephone + mot de passe.
- [ ] Verifier que l'ERP ouvre les donnees de la bonne boutique.
- [ ] Verifier qu'on ne retombe pas sur l'inscription.

Resultat attendu: connexion directe vers `core.html`.

## 2.3 Licence suspendue

- [ ] Suspendre une licence dans l'admin.
- [ ] Essayer de se connecter.
- [ ] Verifier que l'acces est bloque.
- [ ] Reactiver la licence.
- [ ] Verifier que les donnees sont intactes apres reactivation.

Resultat attendu: suspension bloque l'acces, reactivation restaure l'acces sans perte de donnees.

---

# 3. Equipe, roles et autorisation

Dependance: licence et proprietaire fonctionnels.

## 3.1 Nouvel utilisateur

- [ ] Depuis un autre appareil ou navigateur, creer un deuxieme utilisateur.
- [ ] Verifier qu'il arrive dans l'ecran d'attente d'autorisation.
- [ ] Verifier qu'il ne peut pas utiliser l'ERP avant validation.
- [ ] Sur le compte proprietaire, ouvrir Definicoes > Equipe.
- [ ] Verifier que le nouvel utilisateur apparait.
- [ ] Lui donner un role.
- [ ] Le mettre en statut actif.
- [ ] Reconnecter le nouvel utilisateur.

Resultat attendu: le nouvel utilisateur entre seulement apres validation du proprietaire.

## 3.2 Roles

- [ ] Tester role proprietaire: acces total.
- [ ] Tester role gerant: acces large mais sans droits proprietaire sensibles si prevu.
- [ ] Tester role vendeur: acces vente/client selon permission.
- [ ] Tester role stock: acces stock/achat selon permission.
- [ ] Tester utilisateur suspendu: acces bloque.
- [ ] Tester suppression utilisateur si disponible.

Resultat attendu: chaque role voit seulement ce qu'il doit voir.

## 3.3 Journal d'audit

- [ ] Faire une vente avec utilisateur 2.
- [ ] Faire un achat avec utilisateur 2.
- [ ] Faire une depense avec utilisateur 2.
- [ ] Verifier dans les historiques que l'auteur apparait.
- [ ] Verifier que le proprietaire voit qui a fait l'action.

Resultat attendu: chaque action importante garde le nom de l'utilisateur.

---

# 4. Parametres de base

Dependance: proprietaire connecte.

- [ ] Modifier nom de boutique.
- [ ] Modifier devise.
- [ ] Modifier theme.
- [ ] Modifier mode de stock: Boutique seule.
- [ ] Modifier mode de stock: Boutique + Armazem.
- [ ] Modifier informations du recu.
- [ ] Ajouter logo de recu si necessaire.
- [ ] Enregistrer les parametres.
- [ ] Rafraichir la page.
- [ ] Verifier que les parametres restent.

Resultat attendu: les parametres sont sauvegardes et appliques apres refresh.

---

# 5. Fournisseurs

Dependance: achat utilisera les fournisseurs.

- [ ] Creer un fournisseur manuellement.
- [ ] Modifier contact / pays / note.
- [ ] Verifier fiche fournisseur.
- [ ] Verifier historique vide au depart.
- [ ] Verifier dette fournisseur a 0 au depart.

Resultat attendu: fournisseur visible et pret pour les achats.

---

# 6. Achat et entree stock

Dependance: parametre mode de stock, fournisseur.

## 6.1 Achat simple paye comptant

- [ ] Aller dans Nova Compra.
- [ ] Choisir fournisseur.
- [ ] Ajouter produit avec nom, code, categorie, variation, photo si possible.
- [ ] Entrer quantite.
- [ ] Entrer prix d'achat.
- [ ] Entrer prix de vente.
- [ ] Enregistrer achat comptant.
- [ ] Verifier notification au proprietaire/gerant si action faite par un autre utilisateur.
- [ ] Verifier historique d'achat.
- [ ] Verifier fiche fournisseur.
- [ ] Verifier stock du produit.

Resultat attendu: achat enregistre, produit cree ou mis a jour, stock augmente selon mode choisi.

## 6.2 Achat a credit

- [ ] Faire un achat avec paiement partiel.
- [ ] Verifier total achat.
- [ ] Verifier montant paye.
- [ ] Verifier reste a payer.
- [ ] Verifier dette fournisseur.
- [ ] Enregistrer paiement fournisseur.
- [ ] Verifier dette apres paiement.

Resultat attendu: la dette fournisseur est correcte et diminue apres paiement.

## 6.3 Variations et images

- [ ] Ajouter plusieurs variations.
- [ ] Verifier affichage dans achat.
- [ ] Verifier affichage dans vente.
- [ ] Verifier affichage dans stock.
- [ ] Tester produit sans image.

Resultat attendu: variation et image restent visibles; sans image, affichage propre.

---

# 7. Stock

Dependance: produits crees par achat.

## 7.1 Affichage stock

- [ ] Ouvrir Estoque.
- [ ] Verifier stock total.
- [ ] Verifier stock boutique.
- [ ] Verifier stock armazem.
- [ ] Verifier valeur du stock.
- [ ] Chercher un produit avec la barre de recherche.
- [ ] Effacer recherche.
- [ ] Rafraichir / revenir dans l'onglet stock.

Resultat attendu: les chiffres sont corrects et se mettent a jour.

## 7.2 Transfert

- [ ] Si mode Boutique + Armazem: transferer un produit de l'armazem vers boutique.
- [ ] Verifier stock armazem diminue.
- [ ] Verifier stock boutique augmente.
- [ ] Transferer tout si fonction disponible.
- [ ] Verifier historique / impact stock.

Resultat attendu: transfert correct sans stock negatif.

## 7.3 Alertes stock

- [ ] Mettre un produit stock faible.
- [ ] Mettre un produit stock fini.
- [ ] Verifier dashboard principal.
- [ ] Verifier Stock intelligent.

Resultat attendu: alertes stock visibles et coherentes.

---

# 8. Clients

Dependance: ventes vont creer historique client.

- [ ] Creer une vente avec client nomme.
- [ ] Aller dans Clientes.
- [ ] Chercher le client.
- [ ] Verifier total achats.
- [ ] Verifier nombre de transactions.
- [ ] Verifier dette si vente a credit.
- [ ] Enregistrer paiement client.
- [ ] Verifier dette apres paiement.

Resultat attendu: fiche client claire, historique correct, dette correcte.

---

# 9. Vente

Dependance: stock + client.

## 9.1 Vente interne

- [ ] Aller dans Nova Venda.
- [ ] Chercher produit.
- [ ] Ajouter produit au panier.
- [ ] Modifier quantite.
- [ ] Modifier prix si necessaire.
- [ ] Confirmer paiement cash.
- [ ] Verifier historique vente.
- [ ] Verifier stock diminue.
- [ ] Verifier dashboard.
- [ ] Verifier tresorerie.
- [ ] Verifier comptabilite.

Resultat attendu: vente interne diminue le stock et augmente caisse/recette.

## 9.2 Vente externe

- [ ] Ajouter produit au panier meme si stock insuffisant.
- [ ] Choisir type externe.
- [ ] Confirmer vente.
- [ ] Verifier que le stock ne diminue pas.
- [ ] Verifier que le fournisseur/cout externe est traite selon logique prevue.
- [ ] Verifier benefice.

Resultat attendu: vente externe ne touche pas le stock boutique.

## 9.3 Multi-paiement

- [ ] Faire une vente avec cash + express.
- [ ] Faire une vente avec cash + cartao.
- [ ] Faire une vente avec une partie credito.
- [ ] Verifier total paiement = total vente.
- [ ] Verifier dette client si credito.

Resultat attendu: paiement accepte seulement si total correct, credit cree dette client.

## 9.4 Produit fini

- [ ] Mettre un produit stock 0.
- [ ] Verifier qu'on peut l'ajouter si vente externe.
- [ ] Verifier blocage ou alerte si vente interne.

Resultat attendu: comportement correct selon interne/externe.

---

# 10. Depenses

Dependance: tresorerie/dashboard.

- [ ] Enregistrer nouvelle depense.
- [ ] Choisir categorie.
- [ ] Entrer montant.
- [ ] Verifier historique depenses.
- [ ] Verifier dashboard depenses.
- [ ] Verifier dashboard principal.
- [ ] Verifier tresorerie.
- [ ] Verifier comptabilite.

Resultat attendu: depense visible partout et diminue resultat/caisse selon logique.

---

# 11. Tresorerie

Dependance: ventes, achats, depenses, paiements.

- [ ] Verifier solde global.
- [ ] Verifier entrees ventes.
- [ ] Verifier sorties depenses.
- [ ] Verifier paiements fournisseurs.
- [ ] Verifier paiements clients.
- [ ] Tester filtre date rapide.
- [ ] Tester date debut/date fin personnalisee.
- [ ] Tester affichage mobile.

Resultat attendu: tresorerie correspond aux mouvements reels.

---

# 12. Comptabilite

Dependance: ventes, achats, depenses, paiements.

- [ ] Ouvrir Demonstracao de resultados.
- [ ] Verifier recettes.
- [ ] Verifier couts.
- [ ] Verifier depenses.
- [ ] Verifier benefice.
- [ ] Ouvrir Balanco simplificado.
- [ ] Verifier dettes clients.
- [ ] Verifier dettes fournisseurs.
- [ ] Ouvrir Diario contabilistico.
- [ ] Verifier debit = credit.
- [ ] Tester filtre date.
- [ ] Tester affichage mobile.

Resultat attendu: comptabilite equilibree et coherente avec les modules.

---

# 13. Revendeurs

Dependance: stock et ventes.

- [ ] Creer revendeur.
- [ ] Ajouter produits en consignation.
- [ ] Verifier stock reserve/diminue selon logique.
- [ ] Enregistrer paiement revendeur.
- [ ] Enregistrer retour si disponible.
- [ ] Verifier historique revendeur.
- [ ] Verifier responsive mobile.

Resultat attendu: consignation claire, paiement/retour traçables.

---

# 14. Corrections

Dependance: actions deja creees.

- [ ] Corriger une vente.
- [ ] Corriger un achat.
- [ ] Corriger une depense.
- [ ] Corriger un paiement.
- [ ] Verifier stock apres correction.
- [ ] Verifier tresorerie apres correction.
- [ ] Verifier comptabilite apres correction.
- [ ] Verifier journal d'audit.

Resultat attendu: correction ne casse pas les historiques et garde une trace.

---

# 15. Imports

Dependance: base deja stable.

## 15.1 Import achats

- [ ] Telecharger modele CSV achat.
- [ ] Remplir 5 lignes.
- [ ] Importer.
- [ ] Verifier preview.
- [ ] Verifier produits crees.
- [ ] Verifier fournisseurs crees.
- [ ] Verifier stock.
- [ ] Tester doublon achat.
- [ ] Tester 100 lignes.

Resultat attendu: import rapide, sans doublons dangereux.

## 15.2 Import ventes

- [ ] Telecharger modele CSV vente.
- [ ] Importer ventes cash.
- [ ] Importer ventes multi-paiement.
- [ ] Importer ventes credit.
- [ ] Verifier produits inexistants.
- [ ] Verifier clients crees.
- [ ] Verifier stock.
- [ ] Verifier dettes.
- [ ] Tester doublon vente.

Resultat attendu: ventes importees correctement et stock/dettes coherents.

## 15.3 Import depenses

- [ ] Importer depenses simples.
- [ ] Tester categories.
- [ ] Tester doublons.
- [ ] Verifier dashboard.
- [ ] Verifier tresorerie.
- [ ] Verifier comptabilite.

Resultat attendu: depenses importees sans fausser les totaux.

---

# 16. Dashboard principal

Dependance: donnees deja creees.

- [ ] Verifier KPI ventes.
- [ ] Verifier KPI benefice.
- [ ] Verifier KPI depenses.
- [ ] Verifier alertes stock.
- [ ] Verifier tresorerie rapide.
- [ ] Verifier dettes.
- [ ] Verifier achats.
- [ ] Verifier performance commerciale.
- [ ] Verifier resume fiscal/comptable.
- [ ] Tester filtres date.
- [ ] Tester responsive mobile.

Resultat attendu: dashboard resume correctement toute la boutique.

---

# 17. Notifications

Dependance: equipe, actions utilisateur, PWA.

## 17.1 Notifications internes

- [ ] Proprietaire connecte sur PC.
- [ ] Utilisateur 2 fait une vente.
- [ ] Verifier notification interne instantanee.
- [ ] Utilisateur 2 fait un achat.
- [ ] Verifier notification interne.
- [ ] Utilisateur 2 fait une depense.
- [ ] Verifier notification interne.
- [ ] Marquer notifications lues.
- [ ] Verifier badge a 0.

Resultat attendu: proprietaire/gerant reçoivent les notifications des autres utilisateurs.

## 17.2 Notifications PWA

- [ ] Installer la PWA sur mobile.
- [ ] Cliquer `Ativar PWA`.
- [ ] Accepter permission notification.
- [ ] Fermer l'application.
- [ ] Depuis autre utilisateur, faire une vente.
- [ ] Verifier notification mobile app fermee.
- [ ] Cliquer notification.
- [ ] Verifier ouverture de l'ERP.

Resultat attendu: notification reçue meme app fermee.

Note mobile: sur iPhone, cela marche seulement si l'app est installee comme PWA sur l'ecran d'accueil.

---

# 18. Offline / PWA

Dependance: PWA installee.

- [ ] Ouvrir l'app en ligne.
- [ ] Couper internet.
- [ ] Verifier que l'app ne deconnecte pas brutalement.
- [ ] Verifier pages deja chargees.
- [ ] Reconnecter internet.
- [ ] Verifier synchronisation normale.
- [ ] Tester refresh.

Resultat attendu: l'app reste utilisable au minimum en consultation, sans perte de session.

---

# 19. Responsive mobile global

Dependance: modules principaux deja testes.

- [ ] Login mobile.
- [ ] Dashboard mobile.
- [ ] Vente mobile.
- [ ] Panier mobile.
- [ ] Achat mobile.
- [ ] Stock mobile.
- [ ] Clients mobile.
- [ ] Depenses mobile.
- [ ] Tresorerie mobile.
- [ ] Comptabilite mobile.
- [ ] Revendeurs mobile.
- [ ] Parametres mobile.
- [ ] Verifier qu'aucun texte long ne casse les cartes.
- [ ] Verifier que le menu hamburger ne cache pas les barres fixes.

Resultat attendu: app confortable sur smartphone.

---

# 20. Securite et limites

- [ ] Acces core.html sans session.
- [ ] Acces admin sans droit admin.
- [ ] Licence inactive.
- [ ] Utilisateur suspendu.
- [ ] Limite appareils.
- [ ] Limite utilisateurs.
- [ ] RLS Supabase avec produits.
- [ ] RLS Supabase avec ventes.
- [ ] RLS Supabase avec achats.
- [ ] RLS Supabase avec depenses.

Resultat attendu: aucun acces non autorise.

---

# Rapport de bug

Copie ce bloc pour chaque probleme trouve.

```txt
ID bug:
Date:
Priorite: P0 / P1 / P2 / P3
Module:
Appareil: PC / Android / iPhone
Navigateur:
Utilisateur / role:

Action faite:

Resultat attendu:

Resultat obtenu:

Message d'erreur exact:

Capture ecran:

Est-ce reproductible ? Oui / Non
Etapes pour reproduire:
1.
2.
3.

Impact sur le business:

Commentaire:
```

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
[ ] Continuer les corrections
[ ] Pret pour beta limitee
[ ] Pret pour beta publique
```

