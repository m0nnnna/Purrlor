// Some dependencies expect Node's `global`. Loaded by index.html before the app, as a file rather
// than an inline script so the Content-Security-Policy needs no exception (deploy/security-headers.conf).
window.global ||= window;
