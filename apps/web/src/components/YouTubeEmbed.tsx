export function YouTubeEmbed({
  videoId,
  startSeconds,
}: {
  videoId: string;
  startSeconds: number;
}) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}${
    startSeconds === 0 ? "" : `&t=${startSeconds}s`
  }`;
  const embedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?playsinline=1${
    startSeconds === 0 ? "" : `&start=${startSeconds}`
  }`;
  return (
    <div
      className="not-prose my-4 min-w-0 overflow-hidden rounded-lg border bg-muted"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex aspect-video min-h-[200px] min-w-0 w-full items-center justify-center bg-card">
        <iframe
          src={embedUrl}
          title="YouTube video player"
          allow="encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="h-full min-h-[200px] w-full border-0"
        />
      </div>
      <div className="flex items-center justify-end px-3 py-2">
        <a
          href={watchUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-primary underline underline-offset-4"
        >
          Open on YouTube
        </a>
      </div>
    </div>
  );
}
