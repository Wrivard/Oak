import { redirect } from 'next/navigation';

/**
 * Il n'y a pas d'accueil à faire lire : le flux commence par l'envoi de photos.
 */
export default function Home() {
  redirect('/upload');
}
