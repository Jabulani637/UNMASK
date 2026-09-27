import { BrowserRouter, Navigate, Route, Routes, Link } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { BellProvider } from './hooks/useBell.jsx';
import Landing from './pages/Landing.jsx';
import Signup from './pages/Signup.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';
import Login from './pages/Login.jsx';
import Forgot from './pages/Forgot.jsx';
import RequestInstitution from './pages/RequestInstitution.jsx';
import Reset from './pages/Reset.jsx';
import Home from './pages/Home.jsx';
import Match from './pages/Match.jsx';
import Chats from './pages/Chats.jsx';
import Chat from './pages/Chat.jsx';
import Reveal from './pages/Reveal.jsx';
import Profile from './pages/Profile.jsx';
import Account from './pages/Account.jsx';
import Notifications from './pages/Notifications.jsx';
import Staff from './pages/Staff.jsx';
import Privacy from './pages/Privacy.jsx';
import Terms from './pages/Terms.jsx';
import AppShell from './components/AppShell.jsx';

/**
 * The gate on the signed-in screens.
 *
 * It waits for /api/auth/me rather than deciding from anything stored in the page,
 * because the only answer that is true is the server's: a session can have been
 * revoked since the browser last looked.
 */
function RequireSignIn({ children }) {
  const { user, checking } = useAuth();

  if (checking) {
    return (
      <AppShell title="Checking your session" intro="Asking the server whether this browser is signed in.">
        <p className="server-line">One moment…</p>
      </AppShell>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function NotFound() {
  return (
    <AppShell title="No such page" intro="Nothing lives at that address.">
      <Link className="btn block" to="/">
        Back to the beginning
      </Link>
    </AppShell>
  );
}

export default function App() {
  // The two v7 flags the console asked for by name, opted into now so a future
  // router upgrade does not change navigation behaviour underneath this app.
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthProvider>
        {/*
          Inside the router because the badge is re-read when the screen changes, and
          inside the auth provider because whose bell it is comes from the server's
          answer about who is signed in — not from anything stored in the page.
        */}
        <BellProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/verify" element={<VerifyEmail />} />
            <Route path="/login" element={<Login />} />
            <Route path="/forgot" element={<Forgot />} />
            <Route path="/request-institution" element={<RequestInstitution />} />
            <Route path="/reset" element={<Reset />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route
              path="/me"
              element={
                <RequireSignIn>
                  <Home />
                </RequireSignIn>
              }
            />
            <Route
              path="/match"
              element={
                <RequireSignIn>
                  <Match />
                </RequireSignIn>
              }
            />
            <Route
              path="/chats"
              element={
                <RequireSignIn>
                  <Chats />
                </RequireSignIn>
              }
            />
            <Route
              path="/chats/:id"
              element={
                <RequireSignIn>
                  <Chat />
                </RequireSignIn>
              }
            />
            <Route
              path="/chats/:id/reveal"
              element={
                <RequireSignIn>
                  <Reveal />
                </RequireSignIn>
              }
            />
            <Route
              path="/profile"
              element={
                <RequireSignIn>
                  <Profile />
                </RequireSignIn>
              }
            />
            <Route
              path="/account"
              element={
                <RequireSignIn>
                  <Account />
                </RequireSignIn>
              }
            />
            <Route
              path="/notifications"
              element={
                <RequireSignIn>
                  <Notifications />
                </RequireSignIn>
              }
            />
            <Route
              path="/staff"
              element={
                // Sign-in is the whole client-side gate. Who may actually read a queue
                // is decided by /api/staff, which answers 404 to a non-admin, and
                // Staff.jsx renders that as "no such page" — this page confirms nothing
                // about a staff area to a student who is not staff.
                <RequireSignIn>
                  <Staff />
                </RequireSignIn>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BellProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
