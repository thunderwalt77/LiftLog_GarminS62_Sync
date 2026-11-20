import AddIcon from '@expo/material-symbols/add.xml';
import ArrowDownwardIcon from '@expo/material-symbols/arrow_downward.xml';
import ArrowUpwardIcon from '@expo/material-symbols/arrow_upward.xml';
import CloseIcon from '@expo/material-symbols/close.xml';
import { AppText } from '@/components/foundation/app-text';
import { NativeIconButton } from '@/components/foundation/native-icon-button';
import { SegmentedGroup, SegmentListFormElement } from '@/components/foundation/segmented-list';
import { TitledSection } from '@/components/foundation/titled-section';
import { spacing, useAppTheme } from '@/hooks/useAppTheme';
import { normalizeExerciseName, WeightedExerciseBlueprint } from '@/models/blueprint-models';
import { useAppSelector } from '@/store';
import { clearExerciseSearchResult } from '@/store/app';
import { uuid } from '@/utils/uuid';
import { useTranslate } from '@tolgee/react';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Keyboard, View } from 'react-native';
import { useDispatch } from 'react-redux';

/** Adds, removes and orders the library exercises the watch may offer instead of this one. */
export function AlternativesEditor({
  exercise,
  onChange,
}: {
  exercise: WeightedExerciseBlueprint;
  onChange: (alternatives: string[]) => void;
}) {
  const { t } = useTranslate();
  const { colors } = useAppTheme();
  const { push } = useRouter();
  const dispatch = useDispatch();
  const [requestId] = useState(() => uuid());
  const searchResult = useAppSelector((x) => x.app.exerciseSearchResult);
  const alternatives = [...exercise.alternatives];

  useEffect(() => {
    if (searchResult?.requestId !== requestId) {
      return;
    }
    dispatch(clearExerciseSearchResult());
    const name = searchResult.exercise.name;
    const key = normalizeExerciseName(name);
    const taken = [exercise.name, ...exercise.alternatives].some((x) => normalizeExerciseName(x) === key);
    if (!taken) {
      onChange([...exercise.alternatives, name]);
    }
  }, [searchResult, requestId, dispatch, exercise, onChange]);

  const openSearch = () => {
    Keyboard.dismiss();
    push({ pathname: '/exercise-search', params: { requestId, exerciseName: '' } });
  };

  const move = (index: number, by: number) => {
    const next = [...alternatives];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item!);
    onChange(next);
  };

  return (
    <TitledSection title={t('exercise.alternatives.title')}>
      <SegmentedGroup>
        {alternatives.map((name, index) => (
          <SegmentListFormElement
            key={name}
            label={name}
            testID={`exercise-alternative-${index}`}
            right={
              <View style={{ flexDirection: 'row', gap: spacing[1] }}>
                <NativeIconButton
                  icon={ArrowUpwardIcon}
                  systemImage="arrow.up"
                  label={t('exercise.alternatives.move_up.button')}
                  disabled={index === 0}
                  onPress={() => move(index, -1)}
                />
                <NativeIconButton
                  icon={ArrowDownwardIcon}
                  systemImage="arrow.down"
                  label={t('exercise.alternatives.move_down.button')}
                  disabled={index === alternatives.length - 1}
                  onPress={() => move(index, 1)}
                />
                <NativeIconButton
                  icon={CloseIcon}
                  systemImage="xmark"
                  label={t('exercise.alternatives.remove.button')}
                  testID={`exercise-alternative-remove-${index}`}
                  onPress={() => onChange(alternatives.filter((_, i) => i !== index))}
                />
              </View>
            }
          />
        ))}
        <SegmentListFormElement
          key="add"
          label={t('exercise.alternatives.add.button')}
          icon={AddIcon}
          systemImage="plus"
          testID="exercise-alternative-add"
          onPress={openSearch}
        />
      </SegmentedGroup>
      <AppText style={{ color: colors.onSurfaceVariant }}>{t('exercise.alternatives.body')}</AppText>
    </TitledSection>
  );
}
