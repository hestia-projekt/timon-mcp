# Identité d'action

Note de conception pour [hestia-projekt/timon-mcp#11](https://github.com/hestia-projekt/timon-mcp/issues/11), sous-issue de [#10](https://github.com/hestia-projekt/timon-mcp/issues/10). Aucun code de production. Les extraits viennent de la release installée `0.1.8-40ae30b1feef`, lue sans écriture :

`~/.timon/desktop-runtime/releases/0.1.8-40ae30b1feef/resources/orchestrator/dist/`

Ci-dessous, `dist/` désigne ce répertoire.

## Décision

**Piste B.** Les outils de [#12](https://github.com/hestia-projekt/timon-mcp/issues/12) à [#17](https://github.com/hestia-projekt/timon-mcp/issues/17) s'ajoutent à l'hôte autonome (`host/`), qui garde le jeton daemon sur la machine et n'ouvre que des routes nommées. Hermes continue de présenter le jeton du plugin (OAuth ou bearer statique). Il ne reçoit ni le jeton daemon, ni un cookie de session, ni un jeton d'appareil.

La piste A décrit un mécanisme qui existe dans le daemon, et qui est le bon modèle le jour où le plugin est chargé et où un jeton délégué existe. Elle ne peut pas servir Hermes sur cette release : le plugin non signé n'est pas chargé, aucun jeton utilisateur borné au plugin n'est délivré, et remettre à Hermes une session ou un jeton d'appareil lui ouvre toute l'API. Le texte d'une issue amont est en fin de note. Elle n'a pas été ouverte. [ai-timon/timon#80](https://github.com/ai-timon/timon/issues/80) couvre déjà les approbations d'outil et l'identité du relais ; elle reste l'issue d'attente pour ces deux points.

## Ce que le code fait aujourd'hui

`POST /mcp` est une route publique du manifeste (`package.json`, sept chemins, plafond dix). Le middleware d'authentification laisse passer une route publique sans identité. Dans ce magasin, le visiteur est `null`.

`dist/plugins/als.js`, lignes 54-63 :

```js
export function currentPluginViewer(pluginId) {
    const store = pluginRequestAls.getStore();
    if (store)
        return store.viewer;
    return { id: `${PLUGIN_OWNER_PREFIX}${pluginId}`, isSuperadmin: false, permissions: [] };
}
```

Un visiteur `null` est une lecture sans filtre. `dist/users/owned.js`, lignes 41-61 : `rowVisible` et `ownerSql` rendent la ligne, et le SQL `1=1`, dès que le visiteur est absent. C'est pour cela que `missions.list` sur la route publique verrait toutes les missions, et que `missions.send` y est interdit.

`lib/mcp/job-runner.js` sort de ce magasin. Le timer est armé dans `apply()`, hors requête. Le daemon traite un magasin vide comme l'identité de fond `plugin:timon-mcp`. Le plugin ne voit alors que les missions dont `owner_user_id` vaut `plugin:timon-mcp`, et les tâches qu'il a créées.

L'hôte autonome ne charge pas le plugin dans le daemon. Il appelle le daemon en HTTP avec le jeton daemon, sur cinq routes (`host/daemon.js`, lignes 17-28). `GET /api/missions` et `GET /api/tasks` en sont absents, le commentaire le dit : ces listes renverraient toutes les lignes de l'installation. Les identifiants inconnus sont refusés avant le réseau, parce que l'hôte ne relit que ce qu'il a lui-même créé.

## Piste A — route non publique, identité de l'appelant

### Le mécanisme est déjà là

Toute route de plugin, publique ou non, entre dans le même magasin. `dist/plugins/context.js`, lignes 717-734 : le routeur appelle `identityFromRequest(req)` puis `runPluginRequest`. Les façades relisent ce magasin à chaque appel (`currentPluginViewer`, `currentPluginOwnerUserId`).

Une route **absente** de `routes.publicPaths` n'atteint ce routeur que si le middleware a déjà posé `req.auth`. Sinon il répond 401 (`dist/plugins-bundled/http/auth.js`, lignes 341-347). L'ordre de résolution, lignes 236-328, est fermé :

1. jeton daemon (`Authorization: Bearer` égal au fichier), `kind: 'daemon-token'`, `isSuperadmin: true`, utilisateur = le superadmin actif le plus ancien, ou `null` ;
2. jeton d'appareil `tdev_` ;
3. ligne vivante de `api_tokens` ;
4. cookie `timon_session`.

Si l'outil appelle `ctx.missions`, `ctx.kanban`, `ctx.questions` **dans** la requête (promesse comprise : le magasin suit les promesses), le visiteur est celui de `req.auth`. Le job runner fait l'inverse : il faut ne pas l'utiliser sur cette route.

Pour un compte superadmin, `viewerFromRequest` (`dist/users/identity.js`, lignes 17-23) rend `{ id: <compte>, isSuperadmin: true }`. `viewerSeesAll` (`dist/users/owned.js`, lignes 35-38) est alors vrai pour toutes les tables possédées. `listMissions` et `listTasks` renvoient toutes les lignes. Un compte ordinaire ne voit que `owner_user_id =` son id. Les lignes `NULL` restent réservées à `:read:all`.

Le quota `pluginPolicy.spawn` ne suit pas le compte. `ctx.missions.spawn` appelle `assertSpawnAllowed(pluginId)` après avoir pris le propriétaire dans le magasin (`dist/plugins/context.js`, lignes 897-912). L'approbation et la fenêtre sont celles du plugin (`dist/plugins/policy.js`, lignes 516-530), que l'appelant soit un job ou une personne. Les dérogations de lancement (`model`, `backend`, `extraSkills`, `extraMcp`, `allow`) passent par `assertSpawnOverrides` : un job, un anonyme, ou un compte sans `agents:privileged-config` reste `RESTRICTED`.

Ce que la piste A ne donne pas, même avec la bonne session :

- **Quota sur le kanban, les pipelines et les workflows.** `taskScope` marque `unattended` seulement pour un job ou un magasin `unattended` (`dist/plugins/context.js`, lignes 246-255). Une requête de personne ne l'est pas. `tasks-facade.js` (lignes 149-160), `pipelines-facade.js` (ligne 175) et `workflows-facade.js` (ligne 96) ne consomment le quota que si `unattended`. Une session de Guillaume qui crée une tâche exécutable, lance un pipeline ou un workflow, échappe à `pluginPolicy.spawn`. Le daemon le veut ainsi : une personne devant l'écran n'est pas une boucle de plugin. Hermes n'est pas cette personne.
- **Le tampon de la réponse.** `ctx.questions.resolve` appelle `resolvePermission` avec l'origine `'plugin'` et `{ kind: 'plugin', id: pluginId }` (`dist/plugins/questions-facade.js`, ligne 173). L'événement ne nomme pas le compte. L'invariant de #10 (l'humain qui décide, et l'agent relais) n'est pas tenu par la façade.
- **Les approbations Allow / Deny.** La façade les exclut (`dist/plugins/questions-facade.js`, lignes 9-11 ; `dist/permissions.js`, lignes 166-175). `question-events.js`, lignes 1-8 : les événements `permission_*` ne sont pas relayés. C'est le vide que décrit #80.
- **Les messages vers un agent quelconque, depuis un job.** `ctx.messages.send` en job ne parle qu'aux agents créés par le plugin (`dist/plugins/messages-facade.js`, lignes 134-136). Une requête superadmin n'a pas cette borne. Le besoin de #14 (message à `<projet>.<rôle>`) n'est donc pas couvert par l'identité `plugin:timon-mcp`.

Les événements `question_pending` rejouent le handler dans l'identité du propriétaire de la mission, et cette identité **force** `isSuperadmin: false` (`dist/plugins/integration-host.js`, lignes 48-55), avec `unattended: true`. Utile pour une notification plus tard, inutile tant que le plugin n'est pas chargé.

### Ce qu'Hermes peut obtenir sans le jeton daemon

| Credential | Délivrance sans jeton daemon | Durée | Révocation | Droits effectifs |
| --- | --- | --- | --- | --- |
| Cookie `timon_session` | `POST /api/auth/login`, avec le mot de passe du compte | 7 jours glissants, plafond 30 jours depuis la création (`dist/users/session.js`, lignes 6-9) | `POST /api/auth/logout` supprime cette session ; un changement de mot de passe supprime toutes les sessions du compte (`dist/plugins-bundled/users/routes.js`, lignes 547-550 et 604) | Le compte entier. Un client sans `Origin` ni `Sec-Fetch-Site` passe le contrôle cross-site (`dist/plugins-bundled/http/auth.js`, lignes 215-234) : le cookie n'est pas réservé à un navigateur. |
| Jeton d'appareil `tdev_` | Code d'appairage émis par une session, puis `POST /api/devices/redeem` | Inactivité 90 jours, glissant à chaque usage (`dist/users/devices.js`, ligne 49) | `revokeDevice` est lu à chaque requête (lignes 16-19, 288-292) | Tous les droits du compte, superadmin compris (lignes 4-7). TLS exigé hors loopback. |
| Jeton `api_tokens` de mission | Injecté dans le processus de la mission (`TIMON_API_TOKEN`). Rien ne le remet à un client externe | Vie de la mission `running` ; un jeton délégué est en plus borné par un TTL | Fin de mission, ou `revokeApiToken` | Plafond de mission ∩ droits du lanceur. `isSuperadmin` n'est pas repris, sauf mission développeur-propriétaire (`dist/users/api-tokens.js`, lignes 1-16 ; `dist/db.js`, `getLiveApiToken`, lignes 7399-7407). `POST /api/permissions/:id/resolve` refuse un `allow` à un `api-token` (`dist/plugins-bundled/missions/routes.js`, lignes 1660-1672). |
| Jeton `api_tokens` sans mission, lié à un compte | **Aucune délivrance.** `createApiToken` n'est appelé que pour une mission, un jeton d'egress, ou un délégué de mission | Le code honorerait une ligne sans `mission_id` comme le compte entier, superadmin compris (`dist/db.js`, lignes 7399-7407) | `revokeApiTokensForUser` | Cette ligne n'est pas créable depuis l'API. |

Le bearer OAuth du plugin et le secret `TIMON_MCP_BEARER_TOKEN` ne sont pas dans cette liste. Ils vivent dans la base du plugin. Le middleware du daemon ne lit pas cette base. Sur une route non publique, il répond 401 avant le handler.

Remettre à Hermes le cookie ou le `tdev_` lui donne le même pouvoir qu'un superadmin sur **toutes** les routes du daemon, pas seulement sur la liste fermée du plugin. Le jeton quitte la machine (configuration d'un agent Telegram). Ce n'est pas un repli acceptable du jeton daemon, qui, lui, reste dans un fichier local lu par l'hôte.

La piste A est en plus inatteignable dans le déploiement actuel : le plugin n'est pas signé, la release ne le charge pas, il n'y a donc ni routeur de plugin ni magasin de requête. L'hôte de #9 est le processus qui répond.

## Piste B — hôte autonome, liste fermée élargie

### Ce que le jeton daemon est

`dist/plugins-bundled/http/auth.js`, lignes 247-249 : le bearer égal au fichier devient `{ kind: 'daemon-token', user: getActiveSuperadmin() ?? null, isSuperadmin: true }`. `getActiveSuperadmin` (`dist/db.js`, lignes 7193-7195) est le superadmin `active` le plus ancien. Sur une installation à un seul opérateur, c'est le compte de Guillaume. Le visiteur des lectures porte alors son id (`dist/users/identity.js`, lignes 21-23), et voit toutes les missions et toutes les tâches.

Ce n'est pas une session de Guillaume. `isPersonAuth` n'accepte que `session` et `device` (`dist/users/identity.js`, lignes 57-58). Plusieurs routes s'en servent pour réserver un geste au navigateur du propriétaire.

### Coût

Le jeton est un super-administrateur. L'hôte est le seul endroit qui le lit, à chaque appel, et qui ouvre une socket vers le loopback (`host/daemon.js`, lignes 1-9 et 45-58). Une route de plus dans `DAEMON_ROUTES` est une capacité d'opérateur. Une route en préfixe, un chemin pris dans l'argument de l'outil, ou un corps recopié tel quel, sort de la liste fermée.

Ce que la piste B ne récupère pas du daemon :

- `pluginPolicy.spawn` ne s'applique pas à un `POST /api/missions` fait avec le jeton daemon. La fenêtre est celle de l'hôte (`TIMON_MCP_SPAWN_MAX`, `TIMON_MCP_SPAWN_WINDOW_MS`). Chaque nouvel appel qui lance un agent ou consomme un abonnement entre dans cette même fenêtre : envoi, steer, création de tâche exécutable, `POST /api/pipelines/:id/run`, `POST /api/workflows/:id/run`.
- L'hôte voit toutes les lignes, y compris celles d'un autre compte le jour où il y en a un. Le filtre « missions de Guillaume seul » n'existe pas sur ce jeton.
- `resolved_by` d'une résolution HTTP est `{ kind: 'user', id: <id du visiteur> }` (`dist/plugins-bundled/missions/routes.js`, lignes 1729-1730). Pour le jeton daemon, cet id est celui du superadmin actif, ou la chaîne `daemon-token` s'il n'y a pas de compte. L'événement ne nomme pas Hermes. Le journal local compense, voir plus bas.
- Élargir une approbation (`scope: session|always`) et `paste` exigent `isPersonAuth` et le propriétaire de la mission (lignes 1703-1727). Le jeton daemon reçoit 403. On n'ajoute pas ces gestes.

La parade, déjà en place pour les cinq routes, s'applique à chaque ajout : la méthode et le chemin sont une constante ; le corps envoyé est construit par l'hôte à partir d'une liste de champs ; la réponse renvoyée à l'outil est une projection (`host/facades.js`, `refuseKeys`, lignes 279-293 et 370-374). Le JSON du daemon n'est pas relu tel quel vers Hermes. Les dérogations (`model`, `backend`, `extraSkills`, `extraMcp`, `allow`, `permissionMode`) restent refusées avant le réseau.

### Liste à ajouter, par sous-issue

Chaque ligne est une route exacte. Rien d'autre sous le même préfixe.

| Issue | Routes | Lecture / geste |
| --- | --- | --- |
| #12 | `GET /api/missions`, `GET /api/missions/:id`, `GET /api/missions/:id/messages/:eventId`, `POST /api/agents/:id/send`, `POST /api/missions/:id/steer`, `POST /api/missions/:id/interrupt`, `DELETE /api/missions/:id`, `POST /api/stop`, `POST /api/missions` (déjà là) | La liste et le détail sont des projections (pas le prompt dans la liste). Le transcript est un outil distinct, corps de message borné. `DELETE` est l'arrêt d'une mission (`killAgent`, `dist/plugins-bundled/missions/routes.js`, lignes 1124-1128). `POST /api/stop` prend `{ agent }` ou `{ project }` et, avec ce jeton, arrête sans filtre de propriétaire (lignes 411-428). Les deux passent par la fenêtre de l'hôte. L'agent d'un lancement reste `_main` ou `<projet>.<rôle>` nommé par l'outil, sans dérogation. |
| #13 | `GET /api/tasks`, `GET /api/tasks/:id`, `POST /api/tasks`, `PUT /api/tasks/:id` | Pas de `DELETE`. Pas de `kanban:delete`. Le déplacement passe par le `PUT`. En 0.1.8, `done_comment` n'est écrit que si la même requête change le statut : pas d'outil de commentaire seul, le commentaire part avec le déplacement. `GET /api/tasks` n'a ni `limit`, ni `project`, ni `agent`, ni `type`, ni pagination ; seul `status` est envoyé, et cette lecture seule est bornée à 8 MiB (`too_large` au-delà). Les champs hors liste sont refusés par l'hôte. `POST /api/tasks` sort du type `chore` fixé aujourd'hui : le corps reste une liste blanche, sans backend, modèle, ni permission. |
| #14 | `GET /api/projects`, `GET /api/agents`, `GET /api/agents/:name`, `POST /api/messages` | `POST /api/messages` exige un `from_mission` et un `from_agent` (`dist/plugins-bundled/missions/routes.js`, lignes 1412-1425). L'hôte les fixe ; il ne les prend pas d'Hermes. Aucune route d'écriture d'agent, de fichier, de skill ou de serveur MCP. |
| #15 | `GET /api/pipelines`, `GET /api/pipelines/:id`, `GET /api/pipelines/runs/:runId`, `POST /api/pipelines/:id/run`, `GET /api/workflows`, `GET /api/workflows/:id`, `GET /api/workflows/:id/runs`, `POST /api/workflows/:id/run`, `GET /api/routines`, `GET /api/routines/:id` | Pas de `POST /api/pipelines`, `PUT`, ni `POST /api/routines`. Les deux `run` entrent dans la fenêtre de l'hôte. |
| #16 | aucun événement daemon vers le plugin | Le plugin n'est pas chargé : `ctx.events.on` n'a pas de processus. L'hôte interroge `GET /api/permissions` et pousse vers l'appelant (webhook signé, secret déjà couvert par `secrets:read`, ou outil de liste). `events:subscribe` ne voit pas les cartes Allow / Deny (#80). |
| #17 | `GET /api/permissions`, `POST /api/permissions/:id/resolve` | Détail dans la section suivante. `GET /api/auth/me` peut être appelé par l'hôte, en interne, pour lire l'id du superadmin actif. La réponse ne sort pas vers l'outil : elle contient l'adresse du compte. |

`GET /api/missions/:id/stream` n'est pas dans la liste : une socket longue avec le jeton daemon est un canal de plus, et le sondage suffit à la notification.

### Approbations d'outil — contournement retenu

[#80](https://github.com/ai-timon/timon/issues/80) dit, en attendant, de répondre aux questions par `ctx.questions` et de seulement signaler les Allow / Deny, sans appeler `/api/permissions`. Ce conseil vise un plugin chargé dans le processus, qui n'a pas à emprunter la session. Ici le processus est l'hôte, `ctx.questions` n'existe pas, et #17 demande à #11 de choisir. Le signalement seul laisse Guillaume cliquer dans l'interface, ce que #10 écarte.

**Contournement retenu : l'hôte appelle les deux routes, avec un corps plus étroit que la route.**

- `GET /api/permissions` liste les cartes des missions visibles. Avec le jeton daemon, c'est toutes les cartes, questions `ask_user` et approbations d'outil. L'outil sépare les deux (`tool_name`, `questionKindOf` dans `dist/permissions.js`, lignes 172-175). La projection vers Hermes reprend la liste blanche de `projectQuestion` pour une question. Une approbation annoncée par le webhook ne porte que le type, l'id, l'outil, la mission, l'agent et les dates : pas de commande, pas de script, pas de `shell_command`, pas de `script_previews`, pas d'`entry`. `list_pending`, appel authentifié, ajoute pour une approbation l'aperçu de `command` (160 caractères ; un jeton `Bearer` et une suite hexadécimale de 32 caractères ou plus sont retirés) et rien d'autre de l'entrée.
- Pour une approbation, `POST /api/permissions/:id/resolve` n'envoie que `{ behavior: "allow" }` ou `{ behavior: "deny", message? }`. L'hôte refuse, avant l'appel, `scope`, `behavior: "paste"` et `updatedInput`. `scope` et `paste` seraient de toute façon rejetés (403, lignes 1703-1727). `updatedInput` sur un `allow` réécrit l'entrée de l'outil : la route le fait passer, c'est pour cela qu'elle interdit l'`allow` à un jeton de mission (lignes 1660-1672). Le jeton daemon, lui, aurait le droit. L'hôte ne le prend pas.
- Pour une question `ask_user` ou un plan kanban, le même `POST` porte `behavior: "allow"` et un `updatedInput` limité à `{ answers, note }` ou `{ plan }`, après la validation déjà écrite dans `questions-facade.js` (`answerDefect`, lignes 64-117). Un `cancel` est un `deny` avec le motif d'annulation de formulaire. Pas d'autre champ.

`questions:answer` dans le manifeste du daemon est commenté comme s'il couvrait les outils dangereux (`dist/plugins/manifest.js`, ligne 270). Le code de la façade dit le contraire. On ne déclare pas cette permission pour obtenir les Allow / Deny : elle ne les donne pas.

### Journal `decided_by` / `relayed_by`

La route tamponne `resolved_by` avec l'id du visiteur, sans le relais, et répond `{ ok: true }`. L'hôte tient donc son propre journal, dans la base sqlite qu'il a déjà (`storage:sql`) :

- `decided_by` : l'id renvoyé par `GET /api/auth/me` sous le jeton daemon (le superadmin actif), ou `daemon-token` si `user` est `null`. L'adresse n'est pas écrite.
- `relayed_by` : le sujet OAuth déjà stocké, c'est-à-dire le condensé de l'adresse, plus le nom du canal (`hermes`). Pas l'adresse en clair.
- l'id de carte, `allow` ou `deny`, et l'instant.

Ce journal est la trace exigée par #10 et #17. L'événement daemon reste l'autre moitié : il porte l'id du superadmin, pas le relais. Les deux ne se contredisent pas. Un deuxième superadmin plus ancien que Guillaume serait celui que le daemon nomme : `getActiveSuperadmin` trie par `created_at`. À un seul opérateur, c'est Guillaume.

## Permissions de manifeste

**Aucune permission nouvelle.** Sur la piste B le daemon ne consulte pas le manifeste du plugin : le jeton daemon passe, et la liste fermée est la borne. Déclarer `missions:transcript`, `questions:answer`, `pipelines:run` ou `agents:read` maintenant donnerait ces droits au plugin le jour où il est chargé, sans que le code de `lib/` s'en serve.

L'invariant de `AGENTS.md` (« aucun droit `agents:*` ») n'a pas à être amendé ici. L'amendement annoncé par #14 (`agents:read` seul) attend un appel réel à `ctx.agents`.

Les noms cités par les sous-issues restent la carte de ce qu'il faudra déclarer **dans le même changement** si un outil passe un jour par `ctx.*`, plugin chargé :

| Issue | Déjà déclarées, inchangées | À déclarer seulement avec un appel `ctx.*` | À ne pas déclarer |
| --- | --- | --- | --- |
| #12 | `missions:read`, `missions:control`, `missions:spawn` | `missions:transcript` | `missions:stop` n'est pas une permission de plugin. C'est un droit de compte, contrôlé sur `POST /api/stop`. Le job de plugin saute ce contrôle ; le jeton daemon le passe parce qu'il est superadmin. |
| #13 | `kanban:read`, `kanban:write` | — | `kanban:read:project` (lecture d'un job sur des projets accordés dans `pluginPolicy.kanban.projects`). `kanban:delete`. |
| #14 | — | `projects:read`, `agents:read`, `messages:send` | `agents:manage`, `agents:privileged-config`, `agents:docs:*`, `agents:export`, `messages:read` tant qu'aucun outil ne lit l'inbox. |
| #15 | — | `pipelines:read`, `pipelines:run`, `workflows:read`, `workflows:run`, `routines:read` | `pipelines:write`, `routines:write`, `workflows` hors lecture et lancement. `pipelines:run` et `workflows:run` sont sensibles : elles ne s'ajoutent qu'avec l'appel. |
| #16 | `settings`, `secrets:read` | `events:subscribe` et `questions:read`, le jour où le plugin chargé s'abonne | Une permission `approvals:*` : elle n'existe pas dans `PLUGIN_PERMISSIONS` (`dist/plugins/manifest.js`). La déclaration serait refusée. |
| #17 | `storage:sql` (le journal) | `questions:read`, `questions:answer` le jour où `ctx.questions` est appelé | `questions:answer` ne donne pas les Allow / Deny. Pas de permission inventée en attendant #80. |

`http:public` reste les sept chemins actuels. Le plafond est dix (`dist/plugins/public-paths.js`, lignes 4-8). On n'y ajoute pas la route d'identité : une route d'identité non publique, sans jeton délégué, ne ferait que 401 pour Hermes.

## Issue amont proposée

À ouvrir plus tard sur `ai-timon/timon`, pas dans ce dépôt, et pas maintenant. #80 reste l'issue des approbations et du champ `relayedVia`. Celle-ci est le jeton qui manque pour que la piste A devienne utilisable par un client externe.

```
Title: Delegated user credential for one plugin route

A third-party plugin can already act as the caller of a non-public route.
`plugins/context.js` enters `runPluginRequest(identityFromRequest(req))`,
and `currentPluginViewer` then scopes `ctx.missions`, `ctx.kanban` and
`ctx.questions` to that caller. A superadmin sees every owned row
(`users/owned.js`, `viewerSeesAll`). `ctx.missions.spawn` still takes
`pluginPolicy.spawn`.

An external MCP client cannot present such a caller without a global
credential:

- the plugin's own OAuth bearer is invisible to
  `createDaemonAuthMiddleware` (`plugins-bundled/http/auth.js`), so a
  route absent from `routes.publicPaths` answers 401;
- nothing issues an `api_tokens` row with a `user_id` and no
  `mission_id`, even though `getLiveApiToken` would honour it as the
  account (`db.js`);
- a session cookie and a `tdev_` device token are accepted, and both
  open the whole API, for 7 to 30 days and 90 idle days.

Please add a revocable credential that:

1. authenticates only under `/api/plugins/<id>/` for one declared plugin;
2. carries one user id, so the facades run as that user, with
   `isSuperadmin` taken from the account (listing every mission when
   the account is superadmin);
3. is marked unattended, so kanban, pipeline and workflow runs still
   take `pluginPolicy.spawn` (`tasks-facade.js` skips the quota when
   the request is attended);
4. lasts a short, stated TTL, rotates, and is revoked with the user;
5. is not a daemon-token, not a session cookie, and not a device token.

`ctx.questions.resolve` should also accept the relay label asked for
in #80, instead of always stamping `{ kind: 'plugin', id }`.

Downstream: hestia-projekt/timon-mcp#11. Until it exists, timon-mcp
keeps the daemon-token inside its loopback host and a closed route list.
```

## Conséquences pour la suite

- #12 à #15 élargissent `host/daemon.js` et la projection de `host/facades.js`, avec la fenêtre de quota existante sur chaque appel qui lance un agent. Les tests de contrat refusent une méthode ou un chemin hors liste, un corps hors liste blanche, et un appel sans bearer du plugin.
- #16 sonde `GET /api/permissions` depuis l'hôte. Pas d'`events:subscribe` tant que le plugin n'est pas chargé.
- #17 ajoute les deux routes de permission, le corps étroit décrit ici, et le journal `decided_by` / `relayed_by`. Elle ne déclare pas de permission de manifeste.
- Le job runner de `lib/mcp/job-runner.js` reste en place pour `POST /mcp` public. Le retirer sur cette route rendrait le visiteur anonyme et ouvrirait toutes les missions.
