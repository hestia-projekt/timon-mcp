# timon-mcp

Plugin Timon qui exposera un serveur MCP Streamable HTTP. Un client MCP pourra alors mandater le pilote `_main`. Le MCP mandate, le pilote orchestre : le plugin transmet le mandat et rapporte la réponse, sans élargir ni réduire les droits du pilote.

## Statut

Squelette (étape 1). Sont en place le manifeste, la route `GET /api/plugins/timon-mcp/health` et les tests de contrat. Le serveur MCP et l'authentification ne sont pas encore là. `lib/mcp/` et `lib/auth/` sont les points de montage des étapes suivantes ; ils n'enregistrent aucune route pour l'instant.

`GET /health` répond `{ "ok": true, "id": "timon-mcp" }`. Une méthode refusée ou une route inconnue répond en JSON (`method_not_allowed`, `not_found`), de même qu'un corps JSON illisible (`invalid_json`).

## Prérequis

Node.js 22 ou plus récent. Aucune dépendance à installer pour lancer les tests.

## Tests

```bash
npm test
```

Contrôle de distribution, depuis ce dossier :

```bash
timon plugin check .
```

## Installation

Ne pas installer ce squelette sur un daemon en service. L'installation viendra avec le serveur et l'authentification.
