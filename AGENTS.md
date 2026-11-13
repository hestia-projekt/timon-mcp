# timon-mcp

Plugin hôte Timon, kind `behavior`, sans slot d'interface. Il deviendra un serveur MCP Streamable HTTP pour mandater le pilote `_main`. Le MCP mandate, le pilote orchestre.

## Branche

La branche d'intégration est `main`.

## Validation

Les deux commandes doivent réussir avant une PR :

1. `npm test`
2. `timon plugin check . --deny guillaume --deny hestia --deny ambactos`

## Invariants

- Le manifeste déclare `id` `timon-mcp`, `apiVersion` 15, `kind` `behavior` et `permissions` vide à cette étape. Chaque étape suivante n'ajoute que les permissions qu'elle utilise.
- Aucun outil ne change la configuration des agents, des serveurs MCP, des skills ou des secrets. Permissions interdites : `agents:privileged-config`, tout droit `agents:*`, `mcp-servers:*`, `skills:*`, `secrets:manage`, `secrets:list`, `secrets:broker`, `admin`.
- Aucun secret dans le dépôt, les tests ou les journaux. Une valeur de test est produite à l'exécution.
- Aucun chemin absolu de machine. Construire les chemins avec `node:path`.
- `files` dans `package.json` n'embarque ni les tests, ni ce fichier, ni `CLAUDE.md`.
- JavaScript ESM, sans étape de build. Le cœur du plugin n'a pas de dépendance npm : les tests apportent leur routeur.
- Ne pas lancer `timon plugin add` sur le daemon en service.
