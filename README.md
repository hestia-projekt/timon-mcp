# timon-mcp

Plugin Timon (`behavior`, API 15) qui expose un serveur MCP Streamable HTTP. Un client MCP mandate le pilote. Le MCP mandate, le pilote orchestre : le plugin transmet le mandat et rapporte la réponse. Il ne modifie ni les agents, ni les serveurs MCP, ni les skills, ni les secrets, ni l'administration.

`POST /mcp` exige un jeton porteur. Sans les réglages d'URL, les routes OAuth répondent que le plugin n'est pas configuré. Ne pas installer le plugin sur un daemon en service pour l'instant : l'exposition réseau (frontal, DNS, certificat) est hors de ce dépôt.

## Point d'entrée

`POST /api/plugins/timon-mcp/mcp`

JSON-RPC 2.0, une seule requête par appel, réponse `application/json`. Pas de flux SSE, pas de session. `Mcp-Session-Id` est facultatif et ignoré. Les révisions parlées sont `2025-06-18` et `2025-03-26`. Une version inconnue à l'initialisation reçoit la plus récente. Un en-tête `MCP-Protocol-Version` présent et inconnu répond `400`.

`GET /mcp` et `DELETE /mcp` répondent `405` si le handler est atteint. Sur le daemon, ces méthodes ne sont pas des chemins publics : un client anonyme reçoit `401` avant le handler.

Le manifeste déclare sept chemins publics (`http:public`), au plus dix. Le daemon limite chacun : 60 requêtes par minute et par adresse, corps de 64 Ko, `POST` cross-site refusé. Un `Origin` d'un autre hôte est refusé (`403`) après l'authentification. Si `Host` porte un port, le port de l'`Origin` (écrit ou implicite) doit être le même. Si `Host` n'en porte pas, une `Origin` du même hôte sans port est acceptée en http comme en https : derrière TLS, le daemon voit souvent `Host: example.com` et `Origin: https://example.com`. Un client non navigateur, sans `Origin`, est accepté. Un lot JSON-RPC (tableau) est refusé.

`GET /health` répond `{ "ok": true, "id": "timon-mcp" }`. Cette route n'est pas publique : elle suit la session du daemon.

## Authentification

Le plugin est à la fois la ressource protégée et le serveur d'autorisation (MCP authorization, révision 2025-06-18). Les chemins n'ont pas de point : un segment de `routes.publicPaths` n'en accepte pas. Les URL `/.well-known/…` sont des réécritures du frontal, plus bas. Elles ne sont pas servies par le plugin.

| Méthode | Chemin | Rôle |
| --- | --- | --- |
| `GET` | `/oauth/protected-resource` | Métadonnées de ressource (RFC 9728). `resource` est l'adresse publique du point MCP. `authorization_servers` contient l'émetteur. |
| `GET` | `/oauth/authorization-server` | Métadonnées du serveur d'autorisation (RFC 8414). PKCE `S256` seulement, grants `authorization_code` et `refresh_token`, authentification client `none`, `registration_endpoint` annoncé. |
| `POST` | `/oauth/register` | Enregistrement dynamique (RFC 7591). Clients publics seulement. Aucun `client_secret`. |
| `GET` | `/oauth/authorize` | Page de consentement, HTML autonome, jeton CSRF côté serveur. |
| `POST` | `/oauth/authorize` | Décision. Un accord délivre un code à usage unique, 60 secondes au plus. |
| `POST` | `/oauth/token` | Échange du code (PKCE S256) ou rotation du refresh token (RFC 6749, corps formulaire ou JSON). |
| `POST` | `/mcp` | Point MCP. `Authorization: Bearer`. |

Tant que `public_url`, `issuer` ou `resource` manque ou n'est pas une URL `http`/`https` absolue, sans utilisateur, requête ni fragment, ces routes répondent `503` avec `error: not_configured`. La page d'autorisation est alors un HTML qui ne délivre pas de code. Aucun hôte n'est codé en dur.

`resource` (RFC 8707) est obligatoire à l'autorisation et à l'échange. Il doit être exactement l'adresse configurée. Un jeton émis pour une autre adresse est refusé au point MCP.

Sans en-tête `Authorization`, `POST /mcp` répond `401` :

```http
WWW-Authenticate: Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"
```

Un jeton présent mais inutilisable, inconnu, expiré ou d'une autre audience ajoute `, error="invalid_token"`. Le corps JSON reste `{ "error": "unauthorized", "message": "…" }`. Le jeton n'y figure pas. Un jeton dans la query string est ignoré. Le schéma `Bearer` ignore la casse. Au-delà de 512 caractères, la valeur présentée est refusée.

Le jeton d'accès est opaque, 15 minutes. Le refresh token dure 30 jours, tourne à chaque usage, et se révoque. Présenter un refresh déjà tourné révoque toute sa famille, y compris le jeton qui l'a remplacé et les accès encore en cours de cette famille. Jusqu'à cette réutilisation, l'accès précédent reste valable jusqu'à son expiration. Le code d'autorisation est retiré à la première présentation, même si le vérificateur PKCE est faux.

`redirect_uri` doit être `https`, ou `http` limité à `localhost` et `127.0.0.1` (les CLI). `http://localhost.evil.com` est refusé. L'URI est liée au client enregistré, comparaison exacte de la chaîne enregistrée. `code_challenge_method=plain` est refusé. Le nombre de clients dynamiques est borné à 128.

Les codes, les jetons et le secret CSRF ne sont enregistrés qu'en empreinte SHA-256. Le sujet est l'empreinte de l'adresse, pas l'adresse. Les lignes expirées sont purgées. Rien de tout cela n'est écrit dans les journaux : le plugin n'y met que des phrases fixes (`oauth: client registered`, `oauth: code issued`, `oauth: tokens issued`, `oauth: refresh rotated`, `oauth: authorization refused`, `oauth: request failed`).

## Réglages

Permission `settings`. Les valeurs sont lues à chaque requête. Vides au départ, sauf le droit documentaire.

| Clé | Rôle |
| --- | --- |
| `public_url` | Origine publique du plugin, sans barre finale. Sert au défi `resource_metadata`. Exemple fictif : `https://mcp.example`. |
| `issuer` | Émetteur OAuth, sans barre finale. Le plugin est le serveur d'autorisation. Souvent la même origine. |
| `resource` | Adresse canonique du point MCP, valeur du paramètre `resource`. Exemple fictif : `https://mcp.example/mcp`. |
| `identity_header` | En-tête lu uniquement sur `/oauth/authorize`. Tant que la valeur n'a jamais été enregistrée, le plugin utilise le nom livré avec lui. Une valeur enregistrée vide désactive cet en-tête et refuse toute autorisation. Ne pas vider le champ en enregistrant les autres réglages : s'il faut le fixer, le renseigner explicitement. |
| `expected_right` | Nom du droit attendu sur la surface. Défaut `timon`. Documentaire : aucun en-tête de droit n'est lu. Il apparaît sur la page de refus. |
| `email_allowlist` | Adresses autorisées, séparées par des virgules, des espaces ou des points-virgules. Vide : tout refuser. |

## Secret du coffre

Un seul secret, en lecture : `TIMON_MCP_BEARER_TOKEN`. C'est le jeton statique des CLI sur l'hôte. Le créer dans le coffre, puis :

```bash
timon secret grant TIMON_MCP_BEARER_TOKEN --scope agent:plugin:timon-mcp
```

Sans grant, `ctx.secrets.get` renvoie vide : le jeton statique est désactivé, le plugin ne plante pas. La valeur est relue à chaque appel. La comparaison porte sur des empreintes SHA-256, en temps constant. Le nom est la constante partagée avec le manifeste, jamais un littéral dans l'appel.

Ce jeton n'est pas lié à une audience. Il ne remplace pas OAuth pour les clients qui découvrent le serveur par le défi `401`.

## Identité

La passerelle est un reverse proxy à session (cookie, lien magique). Elle sert sa propre page de connexion, puis renvoie sur le chemin demandé, y compris `/oauth/authorize`. Elle applique le droit avant de proxifier : seules les adresses des comptes qui ont le droit de la surface passent.

Elle transmet à l'amont un seul en-tête, `x-ambactos-email`. <!-- timon-check: nom de l'en-tête transmis par la passerelle, contrat d'identité -->

Il n'y a pas d'en-tête de droit, de niveau, ni de marqueur interne ou externe. Le plugin n'en suppose aucun. `expected_right` n'est qu'un libellé.

`IdentityResolver` (`lib/auth/identity.js`) répond `{ subject, email }` ou `null`. Il refuse si le nom d'en-tête n'est pas configuré, si l'en-tête est absent ou vide, ou si l'adresse n'est pas dans l'allowlist. Une allowlist vide refuse tout le monde. Le refus est une page HTML, sans redirection et sans code. L'adresse n'est pas affichée.

L'en-tête n'est lu que sur `GET` et `POST /oauth/authorize`. Sur `/mcp` et sur les autres routes, il est ignoré : il ne tient pas lieu de jeton.

Le sujet enregistré avec le code et les jetons est l'empreinte SHA-256 de l'adresse normalisée (espaces retirés, minuscules). Les journaux ne contiennent pas l'adresse en clair.

### Modèle de menace

Le client, depuis l'extérieur, ne peut pas forger l'en-tête : le frontal le retire sur les chemins publics, puis la passerelle le pose après avoir vérifié la session. La ligne de retrait vise `x-ambactos-email`. <!-- timon-check: en-tête à vider en bordure avant que la passerelle ne le pose -->

Tout processus local qui joint le daemon peut poser cet en-tête lui-même. C'est une limite acceptée sur l'hôte : le daemon n'est pas exposé directement.

L'allowlist est une défense en profondeur. La passerelle a déjà filtré le droit. Une liste vide n'accorde rien, même si un en-tête arrive.

### Exposition, hors mandat

Les chemins publics d'ambactos-surface retirent `Authorization` et `Cookie`. <!-- timon-check: composant qui retire ces en-têtes sur les chemins publics -->

Cela convient à `/oauth/token`, `/oauth/register` et aux métadonnées. Le consentement n'utilise pas de cookie : le jeton CSRF est dans le formulaire et son empreinte est en base. En revanche, `/mcp` a besoin d'un mode « public avec Authorization » pour que le jeton porteur arrive au plugin. Ce changement est côté passerelle, pas dans ce dépôt.

## Réécritures prévues

Le frontal, plus tard, réécrit les URL publiques vers le préfixe du plugin. Hôte fictif, rien n'est installé ici :

```nginx
rewrite ^/.well-known/oauth-protected-resource$ /api/plugins/timon-mcp/oauth/protected-resource last;
rewrite ^/.well-known/oauth-authorization-server$ /api/plugins/timon-mcp/oauth/authorization-server last;
rewrite ^/oauth/(.*)$ /api/plugins/timon-mcp/oauth/$1 last;
rewrite ^/mcp$ /api/plugins/timon-mcp/mcp last;
```

`/mcp` doit transmettre `Authorization` jusqu'au daemon. Les chemins publics vident l'en-tête d'identité avant la passerelle, comme dit plus haut. `proxy_pass` vers `http://<daemon>` reste un exemple : l'adresse réelle est un réglage de l'opérateur, pas une valeur du plugin.

## Clients

Les clients qui parlent OAuth (claude.ai, ChatGPT, Grok) partent du `401` et de `resource_metadata`, enregistrent un client public, puis font le flux code + PKCE S256. L'opérateur renseigne les trois URL, l'allowlist, et place la passerelle devant `/oauth/authorize`. Aucune valeur de jeton ne se met dans le dépôt.

Les CLI sur l'hôte (Claude Code, Codex, Cursor) utilisent le jeton statique. Même forme, URL fictive :

```json
{
  "mcpServers": {
    "timon": {
      "type": "http",
      "url": "https://mcp.example/mcp",
      "headers": {
        "Authorization": "Bearer <TIMON_MCP_BEARER_TOKEN>"
      }
    }
  }
}
```

`<TIMON_MCP_BEARER_TOKEN>` désigne le secret du coffre. Ce n'est pas une valeur à coller.

## Outils

La liste est fermée. Un autre nom renvoie un résultat `isError` « outil inconnu », sans appel aux façades. Chaque schéma a `additionalProperties: false`.

| Outil | Rôle |
| --- | --- |
| `ask_main` | Mandat au pilote. Sans `project`, l'agent est `_main`. Avec `project` (`^[a-z0-9][a-z0-9-]{0,39}$`), l'agent est `<project>.main`. Aucun autre nom d'agent. Sans `mission_id`, `missions.spawn({ agent, mission })`. Avec `mission_id`, `missions.send`. Réponse `{ mission_id, agent, status }`. Message limité à 20 000 caractères. |
| `get_reply` | État de la mission et dernier message de l'agent, via `missions.get` (`missions:read`). |
| `wait` | Même forme que `get_reply`, plus `done`. Attente côté serveur, 25 s par défaut, 50 s au plus. |
| `list_missions` | Missions du plugin : `id`, `agent_name`, `status`, `title`, `started_at`, `ended_at`. Le prompt n'est pas renvoyé. |
| `list_tasks` | Tâches visibles par le plugin, via `ctx.kanban`. La description n'est pas renvoyée. |
| `create_task` | Tâche `chore` du projet, assignée à `<project>.main`. Pas de backend, de modèle, de pipeline ni de permission. |

`spawn` n'envoie aucun override (`model`, `backend`, `extraSkills`, `extraMcp`, `allow`).

`get_reply` ne déclare pas `missions:transcript`. Le corps du dernier message n'est renvoyé que s'il est déjà porté par la mission (`last_message` ou `messages`). Sinon la réponse contient le `summary` et l'état, et `message` vaut `null`.

`wait` s'appuie sur `ctx.events.on('turn_complete')` quand cet appel est disponible. La permission `events:subscribe` n'est pas déclarée : si l'appel lève, le plugin sonde l'état à intervalle court. `done` passe à `true` sur `turn_complete` pour cette mission, ou si le statut est terminal (`completed`, `failed`, `terminated`, `cancelled`). Une conversation encore ouverte reste `running` : le sondage du seul statut peut expirer avec `done: false`.

Un refus de politique (`PluginPolicyError`, ou `reason: 'spawn_policy'`) est un résultat d'outil `isError`, avec le texte « en attente d'approbation de l'opérateur ». Ce n'est pas une erreur HTTP 500, et le plugin ne relance pas l'appel.

## Identité des appels

Une route publique a un appelant anonyme. Dans ce contexte, `missions.send` est interdit et `missions.list` / `get` lisent toutes les missions. Chaque outil s'exécute donc hors de la requête, sous l'identité de tâche de fond `plugin:timon-mcp`, par la pompe démarrée dans `apply()` (`lib/mcp/job-runner.js`). Le plugin ne voit alors que les missions qu'il a lancées et les tâches qu'il a créées.

## Permissions

`http:public`, `missions:spawn`, `missions:read`, `missions:control`, `kanban:read`, `kanban:write`, `settings`, `secrets:read`, `storage:sql`.

`missions:control` sert à `send`. Les outils n'exposent ni `kill`, ni `fork`, ni `stopScope`. `secrets:read` ne sert qu'au jeton statique. `storage:sql` ne sert qu'aux clients, codes et jetons OAuth. Aucun droit de configuration (`agents:*`, `mcp-servers:*`, `skills:*`, `secrets:manage`, `secrets:list`, `secrets:broker`, `admin`, `agents:privileged-config`).

## Configuration opérateur

Tant que le plugin n'est pas signé, `missions:spawn` est refusé tant que l'identifiant n'est pas approuvé. Les tâches créées depuis l'identité de fond passent par la même politique et le même quota. Dans `timon.config.json` :

```json
{
  "pluginPolicy": {
    "spawn": {
      "approved": ["timon-mcp"],
      "max": 5,
      "windowMs": 3600000
    }
  }
}
```

`max` et `windowMs` sont le quota de l'opérateur (ici 5 départs par heure, comme l'exemple de la documentation Timon). Un plugin signé est approuvé par sa signature et reste soumis au quota.

## Prérequis et tests

Node.js 22 ou plus récent. Aucune dépendance npm : le sous-ensemble stateless de MCP Streamable HTTP est un petit noyau JSON-RPC dans `lib/mcp/`. `@timon-ai/sdk` n'est pas publié. Les tests de contrat (`node:test`) suivent le contrat documenté du daemon et utilisent le faux contexte de `test/helpers/fake-ctx.js`. Le double SQL des tests s'appuie sur `node:sqlite` ; le plugin, lui, n'appelle que `ctx.sql`.

```bash
npm test
```

Contrôle de distribution, depuis ce dossier :

```bash
timon plugin check .
```
