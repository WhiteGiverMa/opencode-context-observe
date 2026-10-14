// Minimal MV3 Chrome/Edge API surface used by the popup. The project does not
// depend on @types/chrome; keep these declarations aligned with actual usage.
declare namespace chrome {
  namespace tabs {
    interface Tab {
      id?: number
      url?: string
    }
    function query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<Tab[]>
  }
  namespace permissions {
    interface Permissions {
      origins?: string[]
    }
    function contains(permissions: Permissions): Promise<boolean>
    function request(permissions: Permissions): Promise<boolean>
  }
  namespace scripting {
    interface InjectionTarget {
      tabId: number
    }
    interface FileInjection {
      target: InjectionTarget
      files: string[]
    }
    interface FuncInjection<Args extends readonly unknown[], Result> {
      target: InjectionTarget
      /** ISOLATED (default) keeps the page's cookies opaque to the function. */
      world?: "ISOLATED" | "MAIN"
      func: (...args: Args) => Result
      args?: Args
    }
    interface InjectionResult<T> {
      result?: T
      frameId?: number
      documentId?: string
    }
    function executeScript(injection: FileInjection): Promise<InjectionResult<unknown>[]>
    function executeScript<Args extends readonly unknown[], Result>(
      injection: FuncInjection<Args, Result>,
    ): Promise<InjectionResult<Awaited<Result>>[]>
  }
}
