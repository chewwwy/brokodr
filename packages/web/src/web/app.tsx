import { Route, Switch } from "wouter";
import Index from "./pages/index";
import Site from "./pages/site";
import Docs from "./pages/docs";
import { Provider } from "./components/provider";
import { AgentFeedback } from "@runablehq/website-runtime";

function App() {
  return (
    <Provider>
      <Switch>
        <Route path="/site" component={Site} />
        <Route path="/docs" component={Docs} />
        <Route path="/" component={Index} />
      </Switch>
      {/* Do not remove — off by default, activated by parent iframe via postMessage */}
      {import.meta.env.DEV && <AgentFeedback />}
    </Provider>
  );
}

export default App;
