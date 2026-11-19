// Ikon SVG buatan sendiri. Ikon antarmuka: 20px, garis 2px, ujung persegi, mengikuti currentColor.

const line = (body: string) =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false">${body}</svg>`;

export const icons: Record<string, string> = {
  camera: line('<path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/>'),
  play: line('<path d="M7 5l12 7-12 7z" fill="currentColor"/>'),
  metronome: line('<path d="M8 3h8l4 18H4z"/><path d="M12 17l5-11"/><path d="M6 15h12"/>'),
  landscape: line('<rect x="2" y="6" width="20" height="12"/>'),
  portrait: line('<rect x="7" y="2" width="10" height="20"/>'),
  download: line('<path d="M12 3v12"/><path d="M6 10l6 6 6-6"/><path d="M4 21h16"/>'),
  share: line('<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 12v9h14v-9"/>'),
  replay: line('<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M3 3v5h5"/>'),
  image: line('<rect x="3" y="3" width="18" height="18"/><circle cx="9" cy="9" r="2"/><path d="M21 16l-5-5-11 10"/>'),
  link: line('<path d="M10 14l4-4"/><path d="M8 11l-3 3a3 3 0 0 0 5 5l3-3"/><path d="M16 13l3-3a3 3 0 0 0-5-5l-3 3"/>'),
};

/** Ujung atas tiap jari saat terangkat: telunjuk, tengah, manis, kelingking. */
const FINGER_TOP = [5, 3, 4, 8];

/**
 * Siluet tangan (punggung tangan menghadap kamera). `up` = jari terangkat dimulai dari telunjuk.
 * Jempol selalu terlipat karena tidak dihitung.
 */
export function handIcon(up: number): string {
  const fingers = FINGER_TOP.map((top, i) => {
    const x = 8 + i * 4.5;
    const y = i < up ? top : 12;
    return `<rect x="${x}" y="${y}" width="4" height="${17 - y}"/>`;
  }).join('');
  const palm = '<path d="M8 16h17v8c0 3-2 5-5 5h-7c-3 0-5-2-5-5z"/>';
  const thumb = '<path d="M8 18l-4-3-2 2 6 7z"/>';
  return `<svg viewBox="0 0 28 30" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false">${fingers}${palm}${thumb}</svg>`;
}

/** Pasang ikon ke semua elemen bertanda data-icon. */
export function mountIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const name = el.dataset.icon!;
    const m = /^hand-(\d)$/.exec(name);
    el.innerHTML = m ? handIcon(Number(m[1])) : (icons[name] ?? '');
  });
}
