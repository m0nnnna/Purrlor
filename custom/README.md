# custom/

This server's own files, which replace the samples Purrlor ships. Git ignores everything here
except this README, so `purrlor update` never overwrites them.

- `terms.html`: your Terms of Service, shown from the login and register screens. Start from
  `apps/web/public/terms.html`, then run `purrlor restart web`. See "Your Terms of Service" in
  the main README.
