# worker

Process Node long, séparé de Next. Boucle sur `jobs`, un handler par `type`.

**Vide à l'étape 2, volontairement.** La structure et le tsconfig existent, les
handlers arrivent à partir de l'étape 3. Voir `PROMPTS.md` et le skill
`queue-handler` pour le pattern de réclamation `FOR UPDATE SKIP LOCKED`.
