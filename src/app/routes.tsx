import { createHashRouter, isRouteErrorResponse, Link, useRouteError } from "react-router";
import { Home } from "./components/Home";
import { Room } from "./components/Room";

function RouteErrorPage() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "Something went wrong while loading this page.";

  return (
    <div className="min-h-screen w-screen flex items-center justify-center bg-[#faf8f3] px-4">
      <div className="tangle-glass-strong rounded-3xl p-6 max-w-md text-center">
        <h1 className="text-2xl font-semibold text-[#2d2d2d] mb-2">Page error</h1>
        <p className="text-sm text-gray-700 mb-4">{message}</p>
        <Link
          to="/"
          className="inline-block px-4 py-2 rounded-full tangle-soft-btn text-sm font-semibold"
        >
          Go back home
        </Link>
      </div>
    </div>
  );
}

export const router = createHashRouter(
  [
    {
      path: "/",
      Component: Home,
      errorElement: <RouteErrorPage />,
    },
    {
      path: "/room/:roomId?",
      Component: Room,
      errorElement: <RouteErrorPage />,
    },
  ]
);
