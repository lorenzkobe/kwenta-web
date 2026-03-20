import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { LandingPage } from './landingPage'
import { AppShell } from '@/components/layout/AppShell'

const LoginPage = lazy(() => import('@/pages/LoginPage').then((m) => ({ default: m.LoginPage })))
const JoinGroupPage = lazy(() => import('@/pages/JoinGroupPage').then((m) => ({ default: m.JoinGroupPage })))
const HomePage = lazy(() => import('@/pages/HomePage').then((m) => ({ default: m.HomePage })))
const BillsPage = lazy(() => import('@/pages/BillsPage').then((m) => ({ default: m.BillsPage })))
const BillDetailPage = lazy(() => import('@/pages/BillDetailPage').then((m) => ({ default: m.BillDetailPage })))
const AddBillPage = lazy(() => import('@/pages/AddBillPage').then((m) => ({ default: m.AddBillPage })))
const GroupsPage = lazy(() => import('@/pages/GroupsPage').then((m) => ({ default: m.GroupsPage })))
const GroupDetailPage = lazy(() => import('@/pages/GroupDetailPage').then((m) => ({ default: m.GroupDetailPage })))
const BalancesPage = lazy(() => import('@/pages/BalancesPage').then((m) => ({ default: m.BalancesPage })))
const SettingsPage = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })))

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="size-5 animate-spin text-blue-600" />
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/join/:inviteCode" element={<JoinGroupPage />} />

          <Route path="/app" element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="bills" element={<BillsPage />} />
            <Route path="bills/new" element={<AddBillPage />} />
            <Route path="bills/:billId" element={<BillDetailPage />} />
            <Route path="groups" element={<GroupsPage />} />
            <Route path="groups/:groupId" element={<GroupDetailPage />} />
            <Route path="balances" element={<BalancesPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  )
}

export default App
