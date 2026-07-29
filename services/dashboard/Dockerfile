# ── Dashboard: SvelteKit SPA served by Nginx ──
#
# IMPORTANTE: docker-compose monta `./dashboard/build` como volumen sobre
# `/usr/share/nginx/html`. Eso significa que lo que se sirve en runtime
# NUNCA es el bundle de la imagen — siempre es el build del host.
#
# Antes este Dockerfile hacía `bun run build` adentro, pero ese resultado
# se descartaba por el volume. Lo sacamos: ahora la imagen es solo nginx
# + nuestra config, y queda como sí mismo (que mostrar si el volume falta).
#
# Workflow correcto:
#   1. Editar archivos en `dashboard/src/...`
#   2. Correr `cd dashboard && bun run build` (o `npm run reload:dashboard`)
#   3. nginx hot-recarga el bundle (no hace falta `docker compose up`)
#
# Si querés rebuildear todo (kernel + dashboard) en un comando:
#   `npm run reload:all`

FROM nginx:alpine

# Fallback content por si el volumen no se monta — lleva un index básico.
RUN mkdir -p /usr/share/nginx/html && \
    echo '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Kernl — dashboard not built</title></head><body style="font-family:monospace;background:#07080C;color:#E0E2EA;padding:40px;line-height:1.6"><h1>Dashboard not built</h1><p>Run <code>cd dashboard &amp;&amp; bun run build</code> on the host, then refresh.</p></body></html>' > /usr/share/nginx/html/index.html

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
