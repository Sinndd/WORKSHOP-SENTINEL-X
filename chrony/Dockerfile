FROM alpine:3.22
RUN apk add --no-cache chrony && mkdir -p /run/chrony && chown chrony:chrony /run/chrony && chmod 750 /run/chrony
COPY chrony.conf /etc/chrony/chrony.conf
USER chrony
# -d : premier plan ; -x : ne touche pas à l'horloge de l'hôte ; -U : tourne sans être root
ENTRYPOINT ["chronyd", "-d", "-x", "-U", "-f", "/etc/chrony/chrony.conf"]
