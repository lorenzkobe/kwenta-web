import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Toaster } from 'sonner'
import { AppShell } from '@/components/layout/AppShell'
import { RequireAuth } from '@/components/auth/RequireAuth'
import { RequireGuest } from '@/components/auth/RequireGuest'
import { RequireAdmin } from '@/components/auth/RequireAdmin'
import { AuthProvider } from '@/hooks/AuthProvider'

// Lazy like every route: the landing page is for signed-out visitors, and as a static import it
// put ~100 kB of marketing components into the entry chunk every signed-in user downloads.
const importLandingPage = () => import('@/landing/LandingPage').then((m) => ({ default: m.LandingPage }))
const importLoginPage = () => import('@/pages/LoginPage').then((m) => ({ default: m.LoginPage }))
const importHomePage = () => import('@/pages/HomePage').then((m) => ({ default: m.HomePage }))
const importBillsPage = () => import('@/pages/BillsPage').then((m) => ({ default: m.BillsPage }))
const importBillDetailPage = () =>
  import('@/pages/BillDetailPage').then((m) => ({ default: m.BillDetailPage }))
const importAddBillPage = () => import('@/pages/AddBillPage').then((m) => ({ default: m.AddBillPage }))
const importGroupsPage = () => import('@/pages/GroupsPage').then((m) => ({ default: m.GroupsPage }))
const importGroupDetailPage = () =>
  import('@/pages/GroupDetailPage').then((m) => ({ default: m.GroupDetailPage }))
const importPeoplePage = () => import('@/pages/PeoplePage').then((m) => ({ default: m.PeoplePage }))
const importPersonDetailPage = () =>
  import('@/pages/PersonDetailPage').then((m) => ({ default: m.PersonDetailPage }))
const importSettingsPage = () => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage }))
const importAdminUsersPage = () =>
  import('@/pages/AdminUsersPage').then((m) => ({ default: m.AdminUsersPage }))

const LandingPage = lazy(importLandingPage)
const LoginPage = lazy(importLoginPage)
const HomePage = lazy(importHomePage)
const BillsPage = lazy(importBillsPage)
const BillDetailPage = lazy(importBillDetailPage)
const AddBillPage = lazy(importAddBillPage)
const GroupsPage = lazy(importGroupsPage)
const GroupDetailPage = lazy(importGroupDetailPage)
const PeoplePage = lazy(importPeoplePage)
const PersonDetailPage = lazy(importPersonDetailPage)
const SettingsPage = lazy(importSettingsPage)
const AdminUsersPage = lazy(importAdminUsersPage)

/**
 * The signed-in pages, warmed once the shell is up so the first tap on a tab does not wait on a
 * chunk download. Login and admin are left out: a signed-in user is past the first and almost
 * never an admin.
 */
const SHELL_PAGE_IMPORTS = [
  importHomePage,
  importBillsPage,
  importBillDetailPage,
  importAddBillPage,
  importGroupsPage,
  importGroupDetailPage,
  importPeoplePage,
  importPersonDetailPage,
  importSettingsPage,
]

let shellPagesWarmed = false

function WarmShellPages() {
  useEffect(() => {
    if (shellPagesWarmed) return
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
    if (connection?.saveData) return
    const warm = () => {
      shellPagesWarmed = true
      // A failed prefetch is not an error: the route's own lazy() retries when it is visited.
      for (const load of SHELL_PAGE_IMPORTS) void load().catch(() => {})
    }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(warm)
      return () => window.cancelIdleCallback(id)
    }
    const t = window.setTimeout(warm, 1500)
    return () => window.clearTimeout(t)
  }, [])
  return null
}

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="size-5 animate-spin text-teal-800" />
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Toaster
          richColors
          position="bottom-right"
          duration={6000}
          closeButton
          expand={false}
          offset={{ bottom: '5rem', right: '1rem' }}
        />
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route element={<RequireGuest />}>
              <Route path="/" element={<LandingPage />} />
              <Route path="/login" element={<LoginPage />} />
            </Route>
            <Route element={<RequireAuth />}>
              <Route
                path="/app"
                element={
                  <>
                    <AppShell />
                    <WarmShellPages />
                  </>
                }
              >
                <Route index element={<HomePage />} />
                <Route path="bills" element={<BillsPage />} />
                <Route path="bills/new" element={<AddBillPage />} />
                <Route path="bills/:billId" element={<BillDetailPage />} />
                <Route path="groups" element={<GroupsPage />} />
                <Route path="groups/:groupId" element={<GroupDetailPage />} />
                <Route path="people" element={<PeoplePage />} />
                <Route path="people/:personId" element={<PersonDetailPage />} />
                {/* Ledger folded into the person page's statement; keep the URL working. */}
                <Route path="people/:personId/ledger" element={<Navigate to=".." replace />} />
                <Route path="balances" element={<Navigate to="/app" replace />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route element={<RequireAdmin />}>
                  <Route path="users" element={<AdminUsersPage />} />
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
