// Pull to refresh — ONE look and ONE behaviour for every scrollable tab root and the opportunity detail.
//
//   const pull = usePullRefresh(() => Promise.all([a.refetch(), b.refetch()]));
//   <ScrollView refreshControl={pullRefresh(pull)}>
//
// The spinner is ink (DESIGN.md: black for structure, never the blue), on iOS and Android alike. `refreshing` is true
// only while HER pull is running, so a background refetch never pops the spinner on its own. The refetch is the
// screen's own queries (react-query refetch / refetchQueries); a failed refetch still ends the spinner.
import React, { useCallback, useRef, useState } from "react";
import { RefreshControl } from "react-native";
import { Bold } from "../../constants/theme";

export interface PullRefreshState {
  refreshing: boolean;
  onRefresh: () => void;
}

export function usePullRefresh(run: () => Promise<unknown>): PullRefreshState {
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(run);
  latest.current = run;
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    Promise.resolve()
      .then(() => latest.current())
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, []);
  return { refreshing, onRefresh };
}

/** The RefreshControl element for a ScrollView / FlatList's `refreshControl` prop. A function, not a wrapper
 *  component: ScrollView clones this element on Android, so it must be a RefreshControl itself. */
export function pullRefresh({ refreshing, onRefresh }: PullRefreshState, testID = "pull-refresh") {
  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Bold.ink} colors={[Bold.ink]} testID={testID} />;
}
