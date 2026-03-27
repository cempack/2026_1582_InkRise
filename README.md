<div align="center">
<img src="docs/assets/pencil.svg" alt="InkRise" width="160" />
<h1><img src="docs/assets/pencil.svg" width="28" height="28" alt="" /> InkRise</h1>
<p><strong>Studio d’écriture pour la fiction longue</strong></p>
<p>Django · React · PostgreSQL · Docker</p>
</div>

---

## ![Globe](docs/assets/globe.svg) Aperçu

InkRise est un **studio d’écriture pensé pour le bureau** : espace axé sur le livre, avec une API **Django**, une interface **React** et une base **PostgreSQL** (SQLite possible pour un démarrage local rapide). Parmi les fonctions proposées :

- ![Pencil](docs/assets/pencil.svg) **Chapitres** — texte riche, sauvegarde automatique, révisions, images intégrées
- ![Users](docs/assets/users.svg) **Personnages** — classes et fiches complètes
- ![Code](docs/assets/code.svg) **Dictionnaire** — entrées de glossaire par projet
- ![Check](docs/assets/check.svg) **Statistiques et mise en forme du livre** — réglages par défaut pour la page livre
- ![Sun](docs/assets/sun.svg) **Thésaurus et correcteur de courts textes** — outils locaux et déterministes
- ![Package](docs/assets/package.svg) **Authentification et profils** — inscription, connexion et profils auteur en session

---

## ![Package](docs/assets/package.svg) Lancement avec Docker

Depuis la racine du dépôt :

```bash
cp .env.example .env   # optionnel : adapter les valeurs
docker compose up --build
```

Ouvrir **http://localhost:8000**, créer un compte, puis un projet.

Administration (facultatif) :

```bash
docker compose exec web python manage.py createsuperuser
```

Les comptes **staff** accèdent à la **Console équipe** sur `/studio-console/`. En production, pour les e-mails de réinitialisation de mot de passe, configurer l’envoi dans `.env` (voir `.env.example`).

---

## ![Code](docs/assets/code.svg) Développement local (sans Docker)

Lorsque les variables PostgreSQL ne sont pas renseignées, l’application utilise **SQLite**.

```bash
python3 -m pip install -r requirements.txt
npm install
npm run build
python3 manage.py migrate
python3 manage.py runserver
```

---

## ![Globe](docs/assets/globe.svg) Configuration

Les variables importantes sont décrites dans **`.env.example`** : `DJANGO_SECRET_KEY`, `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, identifiants PostgreSQL et option SMTP pour la réinitialisation de mot de passe.

## ![Package](docs/assets/package.svg) Structure du projet

| Chemin                          | Rôle                                       |
| :------------------------------ | :----------------------------------------- |
| `src/inkrise/`                  | Paramètres du projet Django et URLs racine |
| `src/studio/`                   | Modèles, vues, API, services, tests        |
| `src/templates/react_app.html` | Enveloppe qui monte l’application React    |
| `src/static/src/`               | Sources React et Quill                     |
| `docker-compose.yml`            | Application + PostgreSQL en local          |
| `docs/assets/`                  | Icônes et ressources de présentation       |

---

## ![Pencil](docs/assets/pencil.svg) Documentation

- [presentation.md](presentation.md) — présentation type cours / soutenance
- [licence.txt](licence.txt)

---
