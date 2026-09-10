import mojangVideo from '../gui/mojanglogo.mp4';
import mouseGif from '../gui/mice.webp';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Play the centered Mojang video (with sound). Audio needs a user gesture, so if
 * autoplay is blocked we start on the first pointer/keydown. Hard timeout so the
 * app never hangs on a broken file.
 */
function playVideoToEnd(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const kick = () => { void video.play().catch(() => {}); };
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('ended', finish);
      video.removeEventListener('error', finish);
      document.removeEventListener('pointerdown', kick);
      document.removeEventListener('keydown', kick);
      clearTimeout(hard);
      resolve();
    };
    video.addEventListener('ended', finish);
    video.addEventListener('error', finish);
    const hard = window.setTimeout(finish, 60000);

    void video.play().catch(() => {
      document.addEventListener('pointerdown', kick);
      document.addEventListener('keydown', kick);
    });
  });
}

/**
 * Intro: centered Mojang video (with sound) on a solid colour "render", plus a
 * mouse running across the bottom. When the video ends, `onMenuReady` builds the
 * menu (so it's ready a full 1s before it becomes visible), then the colour
 * render fades out over 1s to reveal it.
 */
export async function playIntro(onMenuReady: () => void): Promise<void> {
  const intro = document.querySelector<HTMLElement>('#intro')!;
  const bg = document.querySelector<HTMLElement>('#intro-bg')!;
  const video = document.querySelector<HTMLVideoElement>('#intro-video')!;
  const mouse = document.querySelector<HTMLImageElement>('#intro-mouse')!;

  mouse.src = mouseGif;
  video.src = mojangVideo;
  video.muted = false;
  video.volume = 1;
  bg.style.opacity = '1';
  intro.hidden = false;

  // Mouse does one 3s run left -> right along the bottom once the video starts.
  video.addEventListener('playing', () => {
    mouse.classList.remove('run');
    void mouse.offsetWidth; // reflow so the animation restarts
    mouse.classList.add('run');
  }, { once: true });

  await playVideoToEnd(video);
  video.hidden = true;

  // Build the menu now — it renders behind the still-solid colour render.
  onMenuReady();
  await wait(100); // let the panorama paint at least one frame

  intro.style.pointerEvents = 'none';
  bg.style.transition = 'opacity 1s linear';
  bg.style.opacity = '0';
  await wait(1000);
  intro.hidden = true;
}
