import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import SearchPanel from './SearchPanel';
import StagingPanel from './StagingPanel';
import { getAppMessage as t } from '../copy/appMessages';

export default function SongComposer({ stagedItem, searchProps, stagingProps }) {
  return (
    <section className="song-composer" aria-label={t('composer.region.label')}>
      <div className="song-composer-viewport">
        <AnimatePresence initial={false} mode="wait">
          {stagedItem ? (
            <motion.div
              key="review"
              className="song-composer-view is-staging"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
            >
              <StagingPanel stagedItem={stagedItem} {...stagingProps} />
            </motion.div>
          ) : (
            <motion.div
              key="add"
              className="song-composer-view is-search"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
            >
              <SearchPanel {...searchProps} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
