import { Wallet } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export function JoinGroupPage() {
  const { inviteCode } = useParams<{ inviteCode: string }>()

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[radial-gradient(circle_at_top,rgba(17,94,89,0.09),transparent_42%),linear-gradient(180deg,#faf8f5_0%,#f0ebe3_55%,#ebe4da_100%)] px-4">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2.5">
          <div className="rounded-xl bg-teal-800/15 p-2.5 text-teal-800">
            <Wallet className="size-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight text-stone-800">Kwenta</span>
        </Link>

        <div className="rounded-[2rem] border border-stone-200 bg-white p-6 shadow-[0_14px_40px_rgba(28,25,23,0.06)] sm:p-8">
          <h1 className="text-center text-2xl font-semibold tracking-tight text-stone-800">
            Join a group
          </h1>
          <p className="mt-2 text-center text-sm text-stone-600">
            You&apos;ve been invited to join a shared expense group
          </p>

          <div className="mt-6 rounded-2xl border border-stone-200 bg-stone-100/80 p-4 text-center">
            <p className="text-xs font-medium text-stone-400">Invite code</p>
            <p className="mt-2 text-lg font-mono font-semibold tracking-widest text-teal-800">
              {inviteCode}
            </p>
          </div>

          <Button className="mt-6 w-full rounded-xl">
            Join group
          </Button>

          <p className="mt-4 text-center text-xs text-stone-400">
            You need an account to join.{' '}
            <Link to="/login" className="text-teal-800 underline-offset-4 hover:underline">
              Sign in or sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
