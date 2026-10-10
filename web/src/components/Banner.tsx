// The maintenance bar above the header (design README "Notices"; spec §5.6): the API's own
// message, full width, in the warning colour. An alert, since the page has stopped working.
export function Banner({ message }: { message: string }) {
  return (
    <div class="banner" role="alert">
      {message}
    </div>
  );
}
