import { activityKyivClock, shiftActivityDate, type SeminarActivityData, type SeminarActivityRole } from './seminarActivity'

/** Synthetic preview only. Never imported by the production data adapter. */
export function createSeminarActivityFixture(now = new Date()): SeminarActivityData {
  const groupId = 'demo-seminars', today = activityKyivClock(now).date
  const names = ['Анна Савчук', 'Богдан Коваль', 'Вікторія Лисенко', 'Данило Мельник', 'Єва Романюк', 'Злата Бондар', 'Іван Гончар', 'Катерина Левченко', 'Лев Шевченко', 'Марія Дорош', 'Назар Мороз', 'Олена Марчук', 'Павло Кравець', 'Софія Ткаченко', 'Тарас Поліщук', 'Уляна Козак', 'Федір Клименко', 'Христина Бойко', 'Юлія Руденко', 'Ярина Павлюк', 'Артем Вовк', 'Валерія Дяченко', 'Гліб Панченко', 'Дарина Сидоренко', 'Емілія Чумак', 'Захар Терещук', 'Ірина Харченко', 'Максим Остапчук', 'Ніка Тимошенко', 'Роман Яремчук']
  const subjects = [
    { id: 'demo-management', name: 'Менеджмент', groupId },
    { id: 'demo-micro', name: 'Мікроекономіка', groupId },
    { id: 'demo-statistics', name: 'Статистика', groupId },
  ]
  const lessons: SeminarActivityData['lessons'] = []
  const reservations: SeminarActivityData['reservations'] = []
  for (let index = 0; index < 15; index += 1) {
    const subject = subjects[index % subjects.length]
    const id = `demo-lesson-${index}`, date = shiftActivityDate(today, index >= 12 ? index - 10 : -(index * 2 + 1))
    lessons.push({ id, groupId, subjectId: subject.id, date, startsAt: '11:20:00', title: `${subject.name}: заняття ${Math.floor(index / 3) + 1}` })
    for (let person = 0; person < names.length; person += 1) {
      if ((person + index) % 4 === 0 || (person + index) % 7 === 0) {
        const role: SeminarActivityRole = index % 5 === 0 ? 'team' : index % 5 === 1 ? 'booking' : (person + index) % 3 === 0 ? 'supplement' : 'primary'
        reservations.push({ id: `demo-reservation-${index}-${person}`, seminarId: id, groupId, userId: `demo-student-${person + 1}`, role })
      }
    }
  }
  return { groupId, subjects, lessons, reservations, members: names.map((name, index) => ({ id: `demo-student-${index + 1}`, name, username: `student_demo_${index + 1}`, groupId, accepted: true })) }
}
