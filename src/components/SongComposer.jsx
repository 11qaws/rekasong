import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import SearchPanel from './SearchPanel';
import StagingPanel from './StagingPanel';

export default function SongComposer({ stagedItem, searchProps, stagingProps }) {
  return (
    <section className="song-composer" aria-label="곡 추가">
      <AnimatePresence initial={false} mode="popLayout">
        {stagedItem ? (
          <motion.div key="review" layout initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
            <StagingPanel stagedItem={stagedItem} {...stagingProps} />
          </motion.div>
        ) : (
          <motion.div key="add" layout initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}>
            <SearchPanel {...searchProps} />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
