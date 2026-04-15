import { Link } from 'react-router-dom'
import { Wallet } from 'lucide-react'

export function LandingFooter() {
  return (
    <footer className="border-t border-stone-200 bg-[#f0ebe3]/90 py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div>
            <Link to="/" className="inline-flex items-center gap-2 text-stone-900">
              <span className="flex size-9 items-center justify-center rounded-xl bg-teal-800/12 text-teal-900">
                <Wallet className="size-4" />
              </span>
              <span className="font-display text-lg font-semibold">Kwenta</span>
            </Link>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-stone-600">
              Flexible bill splitting for personal ledgers and collaborative groups.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">Product</p>
              <ul className="mt-3 space-y-2 text-sm">
                <li>
                  <a href="#demo" className="text-stone-700 hover:text-stone-900">
                    Experience
                  </a>
                </li>
                <li>
                  <a href="#features" className="text-stone-700 hover:text-stone-900">
                    Features
                  </a>
                </li>
                <li>
                  <a href="#how-it-works" className="text-stone-700 hover:text-stone-900">
                    How it works
                  </a>
                </li>
                <li>
                  <a href="#benefits" className="text-stone-700 hover:text-stone-900">
                    Why sign in
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">Account</p>
              <ul className="mt-3 space-y-2 text-sm">
                <li>
                  <Link to="/login" className="text-stone-700 hover:text-stone-900">
                    Sign in
                  </Link>
                </li>
              </ul>
            </div>
            <div className="col-span-2 sm:col-span-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-stone-500">Legal</p>
              <p className="mt-3 text-sm text-stone-500">Use Kwenta at your own risk. No warranty implied.</p>
            </div>
          </div>
        </div>

        <p className="mt-10 border-t border-stone-200/80 pt-8 text-center text-xs text-stone-500">
          © {new Date().getFullYear()} Kwenta. Built for clarity in shared spending.
        </p>
      </div>
    </footer>
  )
}
