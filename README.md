# timon-mcp

Plugin Timon (`behavior`, API 15) qui expose un serveur MCP Streamable HTTP. Un client MCP mandate le pilote. Le MCP mandate, le pilote orchestre : le plugin transmet le mandat et rapporte la réponse. Il ne modifie ni les agents, ni les serveurs MCP, ni les skills, ni les secrets, ni l'administration.

Le point d'entrée n'est pas authentifié à cette étape. `authenticate(req)` laisse passer toute requête. L'étape 3 le remplace par OAuth et le jeton. Ne pas exposer `POST /mcp` sur un réseau ouvert avant cette étape, et ne pas installer le plugin sur un daemon en service pour l'instant.

## Point d'entrée

`POST /api/plugins/timon-mcp/mcp`

JSON-RPC 2.0, une seule requête par appel, réponse `application/json`. Pas de flux SSE, pas de session. `Mcp-Session-Id` est facultatif et ignoré. Les révisions parlées sont `2025-06-18` et `2025-03-26`. Une version inconnue à l'initialisation reçoit la plus récente. Un en-tête `MCP-Protocol-Version` présent et inconnu répond `400`.

`GET /mcp` et `DELETE /mcp` répondent `405` si le handler est atteint. Sur le daemon, ces méthodes ne sont pas des chemins publics : un client anonyme reçoit `401` avant le handler.

Le manifeste déclare uniquement `POST /mcp` dans `routes.publicPaths` (`http:public`). Le daemon limite ce chemin : 60 requêtes par minute et par adresse, corps de 64 Ko, `POST` cross-site refusé. Un `Origin` d'un autre hôte ou port est refusé (`403`). Un client non navigateur, sans `Origin`, est accepté. Un lot JSON-RPC (tableau) est refusé.

`GET /health` répond `{ "ok": true, "id": "timon-mcp" }`.

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

`http:public`, `missions:spawn`, `missions:read`, `missions:control`, `kanban:read`, `kanban:write`.

`missions:control` sert à `send`. Les outils n'exposent ni `kill`, ni `fork`, ni `stopScope`.

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

Node.js 22 ou plus récent. Aucune dépendance npm : le sous-ensemble stateless de MCP Streamable HTTP est un petit noyau JSON-RPC dans `lib/mcp/`. `@timon-ai/sdk` n'est pas publié. Les tests de contrat (`node:test`) utilisent le faux contexte de `test/helpers/fake-ctx.js`, calé sur le contrat documenté du daemon.

```bash
npm test
```

Contrôle de distribution, depuis ce dossier :

```bash
timon plugin check .
```
